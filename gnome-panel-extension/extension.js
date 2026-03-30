import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

const EXTENSION_ID = 'dictray-gnome-panel@okzea';
const PANEL_DIR = `${GLib.get_user_config_dir()}/dictray/gnome-panel`;
const STATUS_FILE = `${PANEL_DIR}/status.json`;
const COMMAND_FILE = `${PANEL_DIR}/command.json`;
const INPUT_FILE = `${PANEL_DIR}/input.json`;
const FOCUSED_WINDOW_FILE = `${PANEL_DIR}/focused-window.json`;
const KEYBINDING_SCHEMA_ID = 'org.gnome.shell.extensions.dictray-gnome-panel';
const KEYBINDING_KEY = 'dictray-toggle';
const POLL_INTERVAL_MS = 1200;
const COMMAND_POLL_INTERVAL_MS = 150;
const ACTIVE_PHASES = new Set(['listening', 'processing', 'transcribing', 'rewriting', 'inserting', 'pending_insert']);
const decoder = new TextDecoder();
const encoder = new TextEncoder();

function compactText(value, limit = 72) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (text.length <= limit)
    return text;

  return `${text.slice(0, Math.max(0, limit - 3)).trim()}...`;
}

function readJsonFile(filePath) {
  const file = Gio.File.new_for_path(filePath);
  if (!file.query_exists(null))
    return null;

  try {
    const [, bytes] = file.load_contents(null);
    if (!bytes)
      return null;

    const payload = JSON.parse(decoder.decode(bytes));
    return payload && typeof payload === 'object' ? payload : null;
  } catch {
    return null;
  }
}

function deleteFile(filePath) {
  try {
    Gio.File.new_for_path(filePath).delete(null);
  } catch {
    // already gone
  }
}

function writeCommand(action) {
  const payload = {action, requestedAt: Date.now()};

  if (arguments.length > 1)
    payload.value = arguments[1];

  try {
    const file = Gio.File.new_for_path(COMMAND_FILE);
    const parent = file.get_parent();
    try {
      parent.make_directory_with_parents(null);
    } catch {
    }

    file.replace_contents(
      encoder.encode(JSON.stringify(payload)),
      null,
      false,
      Gio.FileCreateFlags.REPLACE_DESTINATION,
      null
    );
  } catch (error) {
    console.error(error);
  }
}

// Clutter virtual keyboard for sending keystrokes to the focused window.
// This works on GNOME Wayland where wtype and xdotool cannot reach native
// Wayland windows.
let _virtualKeyboard = null;

function getVirtualKeyboard() {
  if (!_virtualKeyboard) {
    const seat = Clutter.get_default_backend().get_default_seat();
    _virtualKeyboard = seat.create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);
  }
  return _virtualKeyboard;
}

function sendCtrlV() {
  const vk = getVirtualKeyboard();
  const now = Clutter.get_current_event_time();
  vk.notify_keyval(now, Clutter.KEY_Control_L, Clutter.KeyState.PRESSED);
  vk.notify_keyval(now, Clutter.KEY_v, Clutter.KeyState.PRESSED);
  vk.notify_keyval(now, Clutter.KEY_v, Clutter.KeyState.RELEASED);
  vk.notify_keyval(now, Clutter.KEY_Control_L, Clutter.KeyState.RELEASED);
}

function sendReturn() {
  const vk = getVirtualKeyboard();
  const now = Clutter.get_current_event_time();
  vk.notify_keyval(now, Clutter.KEY_Return, Clutter.KeyState.PRESSED);
  vk.notify_keyval(now, Clutter.KEY_Return, Clutter.KeyState.RELEASED);
}

function isElectronWindow(win) {
  if (!win)
    return false;

  const wmClass = (win.get_wm_class?.() || '').toLowerCase();
  const wmInstance = (win.get_wm_class_instance?.() || '').toLowerCase();
  return wmClass === 'electron' || wmInstance === 'electron';
}

function findUserWindow() {
  // Return the most recently used non-Electron normal window.
  const windows = global.get_window_actors()
    .map(a => a.get_meta_window())
    .filter(w => w
      && w.get_window_type() === Meta.WindowType.NORMAL
      && !w.is_skip_taskbar()
      && !isElectronWindow(w))
    .sort((a, b) => b.get_user_time() - a.get_user_time());
  return windows.length > 0 ? windows[0] : null;
}

function activateUserWindow() {
  const win = findUserWindow();
  if (win)
    win.activate(global.get_current_time());
}

function writeFocusedWindowGeometry() {
  try {
    let win = global.display.focus_window;
    // If focus landed on the Electron overlay, find the real user window.
    if (!win || isElectronWindow(win))
      win = findUserWindow();

    if (!win) {
      deleteFile(FOCUSED_WINDOW_FILE);
      return;
    }

    const rect = win.get_frame_rect();
    const payload = {
      left: rect.x,
      top: rect.y,
      width: rect.width,
      height: rect.height,
      title: win.get_title() || '',
      updatedAt: Date.now(),
    };

    const file = Gio.File.new_for_path(FOCUSED_WINDOW_FILE);
    file.replace_contents(
      encoder.encode(JSON.stringify(payload)),
      null,
      false,
      Gio.FileCreateFlags.REPLACE_DESTINATION,
      null
    );
  } catch {
    // ignore — window may have been destroyed between check and read
  }
}

const DicTrayIndicator = GObject.registerClass(
class DicTrayIndicator extends PanelMenu.Button {
  constructor() {
    super(0.5, 'DicTray');
    this._state = null;
    this._menuSignature = '';

    const box = new St.BoxLayout({
      x_expand: false,
      y_expand: false,
      y_align: Clutter.ActorAlign.CENTER,
    });
    this._statusDot = new St.Label({
      text: '○',
      y_align: Clutter.ActorAlign.CENTER,
    });
    this._title = new St.Label({
      text: ' DicTray',
      y_align: Clutter.ActorAlign.CENTER,
      style_class: 'dictray-panel-label',
    });
    this._statusDot.style = 'margin-right: 4px; color: #9aa0a6;';
    box.add_child(this._statusDot);
    box.add_child(this._title);
    this.add_child(box);
    this.menu._boxPointer?.setSourceAlignment?.(0.5);
    this.menu.boxPointer?.setSourceAlignment?.(0.5);

    this._statusPollId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, POLL_INTERVAL_MS, () => {
      this._syncFromStatus();
      return GLib.SOURCE_CONTINUE;
    });

    this._commandPollId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, COMMAND_POLL_INTERVAL_MS, () => {
      this._processCommand();
      return GLib.SOURCE_CONTINUE;
    });

    this._applyMissingState();
  }

  _processCommand() {
    writeFocusedWindowGeometry();

    const command = readJsonFile(INPUT_FILE);
    if (!command)
      return;

    deleteFile(INPUT_FILE);

    const action = String(command.action || '').trim();
    if (action === 'send_ctrl_v') {
      activateUserWindow();
      sendCtrlV();
      return;
    }
    if (action === 'send_return') {
      sendReturn();
      return;
    }
  }

  _syncFromStatus() {
    const next = readJsonFile(STATUS_FILE);
    if (!next) {
      this._applyMissingState();
      return;
    }

    if (next.quit) {
      this._applyQuitState();
      return;
    }

    this._state = next;
    const phase = String(next.phase || '').trim() || 'idle';
    const dictating = ACTIVE_PHASES.has(phase);
    this._statusDot.text = dictating ? '●' : '○';
    this._statusDot.style = dictating
      ? 'margin-right: 4px; color: #7ee787;'
      : 'margin-right: 4px; color: #9aa0a6;';
    this._title.text = ` DicTray (${String(next.hotkey || 'shortcut').trim()})`;
    this._syncMenu(next.menu);
  }

  _applyMissingState() {
    this._statusDot.text = '○';
    this._statusDot.style = 'margin-right: 4px; color: #9aa0a6;';
    this._title.text = ' DicTray';
    this._state = null;
    this._syncMenu([
      {label: 'Status: waiting for app...', enabled: false},
      {type: 'separator'},
      {label: 'Target: unavailable', enabled: false},
      {label: 'Note: unavailable', enabled: false},
      {label: 'Error: none', enabled: false},
    ]);
  }

  _applyQuitState() {
    this._statusDot.text = '○';
    this._statusDot.style = 'margin-right: 4px; color: #9aa0a6;';
    this._title.text = ' DicTray (stopped)';
    this._state = null;
    this._syncMenu([
      {label: 'App has quit', enabled: false},
    ]);
  }

  _syncMenu(items) {
    const nextItems = Array.isArray(items) ? items : [];
    const signature = JSON.stringify(nextItems);
    if (signature === this._menuSignature)
      return;

    this._menuSignature = signature;
    this.menu.removeAll();
    for (const item of nextItems)
      this.menu.addMenuItem(this._createMenuItem(item));
  }

  _createMenuItem(item) {
    if (!item || item.type === 'separator')
      return new PopupMenu.PopupSeparatorMenuItem();

    if (Array.isArray(item.submenu)) {
      const submenu = new PopupMenu.PopupSubMenuMenuItem(String(item.label || '').trim() || 'Untitled');
      submenu.setSensitive(item.enabled !== false);
      for (const child of item.submenu)
        submenu.menu.addMenuItem(this._createMenuItem(child));
      return submenu;
    }

    const menuItem = new PopupMenu.PopupMenuItem(String(item.label || '').trim() || 'Untitled');
    menuItem.setSensitive(item.enabled !== false);

    if (item.type === 'checkbox')
      menuItem.setOrnament(item.checked ? PopupMenu.Ornament.CHECK : PopupMenu.Ornament.NONE);
    else if (item.type === 'radio')
      menuItem.setOrnament(item.checked ? PopupMenu.Ornament.DOT : PopupMenu.Ornament.NONE);

    if (item.command && item.enabled !== false) {
      menuItem.connect('activate', () => {
        writeCommand(String(item.command.action || ''), item.command.value);
      });
    }

    return menuItem;
  }

  destroy() {
    if (this._statusPollId) {
      GLib.source_remove(this._statusPollId);
      this._statusPollId = null;
    }
    if (this._commandPollId) {
      GLib.source_remove(this._commandPollId);
      this._commandPollId = null;
    }

    super.destroy();
  }
});

export default class DicTrayExtension extends Extension {
  enable() {
    if (this._indicator)
      this._indicator.destroy();

    this._lastToggleMs = 0;
    this._indicator = new DicTrayIndicator();
    Main.panel.addToStatusArea(EXTENSION_ID, this._indicator, 1, 'right');

    this._bindKeybindings();
  }

  disable() {
    this._unbindKeybindings();
    _virtualKeyboard = null;

    if (!this._indicator)
      return;

    this._indicator.destroy();
    this._indicator = null;
  }

  _bindKeybindings() {
    try {
      const settings = this.getSettings(KEYBINDING_SCHEMA_ID);
      Main.wm.addKeybinding(
        KEYBINDING_KEY,
        settings,
        Meta.KeyBindingFlags.IGNORE_AUTOREPEAT,
        Shell.ActionMode.ALL,
        () => {
          const now = GLib.get_monotonic_time() / 1000;
          if ((now - this._lastToggleMs) < 500)
            return;
          this._lastToggleMs = now;
          // Remember the user's window so we can restore focus after
          // the Electron overlay appears (XWayland steals focus).
          const userWindow = findUserWindow();
          writeCommand('toggle');
          if (userWindow) {
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 400, () => {
              if (isElectronWindow(global.display.focus_window))
                userWindow.activate(global.get_current_time());
              return GLib.SOURCE_REMOVE;
            });
          }
        },
      );
    } catch (error) {
      console.error(`[dictray] Failed to register keybinding: ${error}`);
    }
  }

  _unbindKeybindings() {
    try {
      Main.wm.removeKeybinding(KEYBINDING_KEY);
    } catch {
      // already removed
    }
  }
}
