import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

const EXTENSION_ID = 'dictray-gnome-panel@okzea';
const PANEL_DIR = GLib.get_user_config_dir() + '/dictray/gnome-panel';
const STATUS_FILE = PANEL_DIR + '/status.json';
const COMMAND_FILE = PANEL_DIR + '/command.json';
const LAUNCHER_FILE = PANEL_DIR + '/launcher.json';
const INPUT_FILE = PANEL_DIR + '/input.json';
const FOCUSED_WINDOW_FILE = PANEL_DIR + '/focused-window.json';
const KEYBINDING_SCHEMA_ID = 'org.gnome.shell.extensions.dictray-gnome-panel';
const KEYBINDING_TOGGLE_KEY = 'dictray-toggle';
const KEYBINDING_PROMPT_KEY = 'dictray-toggle-submit';
const KEYBINDING_CANCEL_KEY = 'dictray-cancel';
const POLL_INTERVAL_MS = 180;
const COMMAND_POLL_INTERVAL_MS = 150;
const STATUS_STALE_MS = 45000;
const LAUNCH_COOLDOWN_MS = 10000;
const OVERLAY_WIDTH = 452;
const OVERLAY_HEIGHT = 146;
const OVERLAY_MARGIN = 28;
const OVERLAY_IDLE_HIDE_MS = 1900;
const OVERLAY_SHOW_Y = 28;
const OVERLAY_HIDE_Y = 20;
const OVERLAY_SHOW_SCALE = 0.86;
const OVERLAY_HIDE_SCALE = 0.9;
const OVERLAY_SHOW_DURATION_MS = 280;
const OVERLAY_HIDE_DURATION_MS = 210;
const ACTIVE_PHASES = new Set(['listening', 'processing', 'transcribing', 'rewriting', 'inserting', 'pending_insert']);
const decoder = new TextDecoder();
const encoder = new TextEncoder();
let _lastLaunchMs = 0;
let _activeExtension = null;

function compactText(value, limit = 72) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (text.length <= limit)
    return text;

  return text.slice(0, Math.max(0, limit - 3)).trim() + '...';
}

function clampUnitInterval(value) {
  return Math.max(0, Math.min(1, Number(value) || 0));
}

function normalizeHotkeyToken(value) {
  const text = String(value || '').trim();
  if (!text)
    return '';

  const lowered = text.toLowerCase();
  if (lowered === 'space')
    return 'space';
  if (/^f\d{1,2}$/i.test(text))
    return text.toUpperCase();
  if (/^[a-z0-9]$/i.test(text))
    return lowered;
  return '';
}

function hotkeyToBindings(value) {
  const parts = String(value || '').split('+').map(part => String(part || '').trim()).filter(Boolean);
  if (!parts.length)
    return [];

  const modifiers = [];
  let key = '';

  for (const part of parts) {
    const lowered = part.toLowerCase();
    if (lowered === 'commandorcontrol' || lowered === 'control' || lowered === 'ctrl') {
      if (!modifiers.includes('<Control>'))
        modifiers.push('<Control>');
      continue;
    }
    if (lowered === 'alt' || lowered === 'option') {
      if (!modifiers.includes('<Alt>'))
        modifiers.push('<Alt>');
      continue;
    }
    if (lowered === 'shift') {
      if (!modifiers.includes('<Shift>'))
        modifiers.push('<Shift>');
      continue;
    }
    if (lowered === 'super' || lowered === 'meta' || lowered === 'command') {
      if (!modifiers.includes('<Super>'))
        modifiers.push('<Super>');
      continue;
    }

    key = normalizeHotkeyToken(part);
  }

  if (!key)
    return [];

  return [modifiers.join('') + key];
}

function sameBindings(a, b) {
  const left = Array.isArray(a) ? a : [];
  const right = Array.isArray(b) ? b : [];
  return JSON.stringify(left) === JSON.stringify(right);
}

function syncRuntimeKeybindings(state = null) {
  _activeExtension?._syncConfiguredKeybindings(state);
}

function simplifyTargetWindow(value) {
  const text = String(value || '').trim();
  if (!text)
    return '';

  const match = text.match(/^(.*?)(?:\s+\([^()]+\))$/);
  return (match?.[1] || text).trim();
}

function buildOverlayCopy(state = {}) {
  const phase = String(state?.phase || 'idle').trim() || 'idle';
  const targetWindow = simplifyTargetWindow(state?.targetWindow || '');
  const message = String(state?.error || state?.note || '').trim();
  const meta = phase === 'pending_insert' ? 'Waiting' : 'DicTray';

  switch (phase) {
    case 'listening':
      return {
        chip: 'Listening',
        meta,
        headline: 'Release when you are done',
        subline: targetWindow || 'Current window'
      };
    case 'processing':
      return {
        chip: 'Processing',
        meta,
        headline: 'Finishing capture',
        subline: targetWindow || 'Current window'
      };
    case 'transcribing':
      return {
        chip: 'Transcribing',
        meta,
        headline: 'Turning speech into text',
        subline: targetWindow || message || 'Current window'
      };
    case 'rewriting':
      return {
        chip: 'Improving',
        meta,
        headline: 'Cleaning up the draft',
        subline: targetWindow || message || 'Current window'
      };
    case 'pending_insert':
      return {
        chip: 'Ready',
        meta: 'Waiting',
        headline: targetWindow ? 'Return to ' + targetWindow : 'Return to the target window',
        subline: targetWindow || message || 'The text will paste when that window is active.'
      };
    case 'inserting':
      return {
        chip: 'Inserting',
        meta,
        headline: 'Sending text',
        subline: targetWindow || 'Current window'
      };
    default:
      if (state?.error) {
        return {
          chip: 'Attention',
          meta,
          headline: 'Dictation needs attention',
          subline: message
        };
      }
      if (state?.note) {
        return {
          chip: 'Done',
          meta,
          headline: 'Dictation finished',
          subline: message
        };
      }
      return {
        chip: 'Idle',
        meta: 'DicTray',
        headline: 'Ready',
        subline: 'Press the shortcut to start dictation.'
      };
  }
}

function overlayThemeForPhase(phase, hasError = false) {
  if (hasError && phase === 'idle') {
    return {
      accent: '#ff8f8f',
      chipBg: 'rgba(255, 128, 128, 0.18)',
      chipText: '#ffe1e1',
      surface: 'rgba(29, 13, 17, 0.94)',
      border: 'rgba(255, 143, 143, 0.28)',
      glow: 'rgba(255, 143, 143, 0.34)',
      textSoft: 'rgba(255, 229, 229, 0.78)'
    };
  }

  switch (phase) {
    case 'listening':
      return {
        accent: '#4df0a5',
        chipBg: 'rgba(53, 214, 134, 0.15)',
        chipText: '#dbffed',
        surface: 'rgba(10, 24, 19, 0.94)',
        border: 'rgba(77, 240, 165, 0.2)',
        glow: 'rgba(77, 240, 165, 0.34)',
        textSoft: 'rgba(220, 250, 234, 0.76)'
      };
    case 'rewriting':
      return {
        accent: '#ffbf66',
        chipBg: 'rgba(255, 190, 96, 0.18)',
        chipText: '#fff0d0',
        surface: 'rgba(28, 19, 8, 0.94)',
        border: 'rgba(255, 191, 102, 0.22)',
        glow: 'rgba(255, 191, 102, 0.34)',
        textSoft: 'rgba(255, 239, 208, 0.78)'
      };
    case 'pending_insert':
    case 'idle':
      return {
        accent: '#ff9d9d',
        chipBg: 'rgba(255, 128, 128, 0.18)',
        chipText: '#ffe1e1',
        surface: 'rgba(28, 12, 16, 0.94)',
        border: 'rgba(255, 157, 157, 0.24)',
        glow: 'rgba(255, 157, 157, 0.28)',
        textSoft: 'rgba(255, 225, 225, 0.8)'
      };
    case 'inserting':
      return {
        accent: '#c3a7ff',
        chipBg: 'rgba(166, 131, 255, 0.18)',
        chipText: '#eee5ff',
        surface: 'rgba(18, 13, 31, 0.94)',
        border: 'rgba(195, 167, 255, 0.22)',
        glow: 'rgba(195, 167, 255, 0.34)',
        textSoft: 'rgba(238, 229, 255, 0.76)'
      };
    default:
      return {
        accent: '#72d2ff',
        chipBg: 'rgba(109, 198, 255, 0.14)',
        chipText: '#d7f4ff',
        surface: 'rgba(10, 20, 33, 0.94)',
        border: 'rgba(183, 227, 255, 0.18)',
        glow: 'rgba(114, 210, 255, 0.3)',
        textSoft: 'rgba(224, 237, 245, 0.78)'
      };
  }
}

class DicTrayOverlay {
  constructor() {
    this._hideTimerId = null;
    this._dismissedNoticeKey = '';
    this._activeNoticeKey = '';
    this._monitorsChangedId = 0;
    this._visible = false;

    this.actor = new St.Widget({
      reactive: true,
      can_focus: true,
      visible: false,
      opacity: 0,
      layout_manager: new Clutter.BinLayout()
    });
    this.actor.set_pivot_point(0.5, 0.5);
    this.actor.connect('key-press-event', (_actor, event) => {
      if (event.get_key_symbol() !== Clutter.KEY_Escape)
        return Clutter.EVENT_PROPAGATE;

      writeCommand('cancel');
      return Clutter.EVENT_STOP;
    });
    this.actor.set_size(OVERLAY_WIDTH, OVERLAY_HEIGHT);

    this._card = new St.BoxLayout({
      vertical: true,
      reactive: false,
      can_focus: false
    });
    this._card.set_size(OVERLAY_WIDTH, OVERLAY_HEIGHT);

    this._topline = new St.BoxLayout({
      reactive: false,
      can_focus: false,
      x_expand: true
    });

    this._chip = new St.BoxLayout({
      reactive: false,
      can_focus: false,
      x_expand: false
    });
    this._dot = new St.Widget({reactive: false, can_focus: false});
    this._dot.set_pivot_point(0.5, 0.5);
    this._chipLabel = new St.Label({text: 'Listening', y_align: Clutter.ActorAlign.CENTER});
    this._chipLabel.clutter_text.set({
      ellipsize: Pango.EllipsizeMode.NONE,
      single_line_mode: true,
    });
    this._chip.add_child(this._dot);
    this._chip.add_child(this._chipLabel);

    this._meta = new St.Label({text: 'DicTray', x_expand: true, y_align: Clutter.ActorAlign.CENTER});
    this._meta.clutter_text.set({
      ellipsize: Pango.EllipsizeMode.END,
      single_line_mode: true,
    });
    this._headline = new St.Label({text: 'Ready'});
    this._headline.clutter_text.line_wrap = true;
    this._subline = new St.Label({text: 'Press the shortcut to start dictation.'});
    this._subline.clutter_text.line_wrap = true;

    this._topline.add_child(this._chip);
    this._topline.add_child(this._meta);
    this._card.add_child(this._topline);
    this._card.add_child(this._headline);
    this._card.add_child(this._subline);
    this.actor.add_child(this._card);

    Main.layoutManager.addChrome(this.actor, {
      affectsInputRegion: false,
      trackFullscreen: true,
    });
    this._monitorsChangedId = Main.layoutManager.connect('monitors-changed', () => {
      this._relayout();
    });
    this._relayout();
  }

  _relayout() {
    const monitor = Main.layoutManager.primaryMonitor || Main.layoutManager.monitors?.[0];
    if (!monitor)
      return;

    const x = Math.round(monitor.x + (monitor.width - OVERLAY_WIDTH) / 2);
    const y = Math.round(monitor.y + monitor.height - OVERLAY_HEIGHT - OVERLAY_MARGIN);
    this.actor.set_position(x, y);
    this.actor.set_size(OVERLAY_WIDTH, OVERLAY_HEIGHT);
    this._card.set_size(OVERLAY_WIDTH, OVERLAY_HEIGHT);
  }

  _noticeKey(state) {
    const phase = String(state?.phase || 'idle').trim() || 'idle';
    const message = String(state?.error || state?.note || '').trim();
    if (phase !== 'idle' || !message)
      return '';

    return [phase, message, String(state?.targetWindow || '').trim()].join('|');
  }

  _cancelHideTimer() {
    if (!this._hideTimerId)
      return;

    GLib.source_remove(this._hideTimerId);
    this._hideTimerId = null;
  }

  _scheduleHide(noticeKey) {
    this._cancelHideTimer();
    this._hideTimerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, OVERLAY_IDLE_HIDE_MS, () => {
      this._hideTimerId = null;
      this._dismissedNoticeKey = noticeKey;
      this.hide();
      return GLib.SOURCE_REMOVE;
    });
  }

  _show() {
    if (this._visible) {
      this.actor.opacity = 255;
      this.actor.translation_y = 0;
      this.actor.scale_x = 1;
      this.actor.scale_y = 1;
      if (!this.actor.visible)
        this.actor.show();
      return;
    }

    this._visible = true;
    this.actor.show();
    this.actor.remove_all_transitions();
    this.actor.translation_y = OVERLAY_SHOW_Y;
    this.actor.scale_x = OVERLAY_SHOW_SCALE;
    this.actor.scale_y = OVERLAY_SHOW_SCALE;
    this.actor.ease({
      opacity: 255,
      duration: OVERLAY_SHOW_DURATION_MS,
      mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
      scale_x: 1,
      scale_y: 1,
      translation_y: 0,
    });
  }

  hide() {
    this._visible = false;
    this.actor.remove_all_transitions();
    this.actor.ease({
      opacity: 0,
      duration: OVERLAY_HIDE_DURATION_MS,
      mode: Clutter.AnimationMode.EASE_IN_CUBIC,
      scale_x: OVERLAY_HIDE_SCALE,
      scale_y: OVERLAY_HIDE_SCALE,
      translation_y: OVERLAY_HIDE_Y,
      onComplete: () => {
        if (!this._visible)
          this.actor.hide();
      },
    });
  }

  hideNow() {
    this._cancelHideTimer();
    this._activeNoticeKey = '';
    this._visible = false;
    this.actor.remove_all_transitions();
    this.actor.opacity = 0;
    this.actor.translation_y = 0;
    this.actor.scale_x = 1;
    this.actor.scale_y = 1;
    this.actor.hide();
  }

  update(state) {
    const overlayEnabled = Boolean(state?.nativeOverlay);
    if (!overlayEnabled) {
      this._dismissedNoticeKey = '';
      this._activeNoticeKey = '';
      this.hideNow();
      return;
    }

    const phase = String(state?.phase || 'idle').trim() || 'idle';
    const note = String(state?.note || '').trim();
    const error = String(state?.error || '').trim();
    const visible = phase !== 'idle' || Boolean(note || error);
    const noticeKey = this._noticeKey(state);

    if (!visible) {
      this._dismissedNoticeKey = '';
      this._activeNoticeKey = '';
      this.hideNow();
      return;
    }

    if (noticeKey && this._dismissedNoticeKey === noticeKey) {
      this.hideNow();
      return;
    }

    if (!noticeKey)
      this._dismissedNoticeKey = '';

    const copy = buildOverlayCopy(state);
    const theme = overlayThemeForPhase(phase, Boolean(error));
    const shadowAlpha = 0.28;
    const dotScale = 1;
    const dotOpacity = 220;

    this._card.style = [
      'padding: 16px 18px',
      'spacing: 10px',
      'border-radius: 24px',
      'border: 1px solid ' + theme.border,
      'background-color: ' + theme.surface,
      'box-shadow: 0 16px 30px rgba(1, 4, 9, ' + shadowAlpha.toFixed(2) + ')',
    ].join('; ');

    this._topline.style = 'spacing: 10px';
    this._chip.style = [
      'spacing: 8px',
      'padding: 7px 12px',
      'border-radius: 999px',
      'background-color: ' + theme.chipBg,
    ].join('; ');
    this._dot.style = [
      'width: 12px',
      'height: 12px',
      'border-radius: 99px',
      'background-color: ' + theme.accent,
      'border: 2px solid rgba(255, 255, 255, 0.12)',
    ].join('; ');
    this._dot.scale_x = dotScale;
    this._dot.scale_y = dotScale;
    this._dot.opacity = dotOpacity;
    this._chipLabel.style = [
      'font-size: 11px',
      'font-weight: 700',
      'letter-spacing: 0.08em',
      'text-transform: uppercase',
      'color: ' + theme.chipText,
    ].join('; ');
    this._meta.style = [
      'font-size: 11px',
      'font-weight: 600',
      'letter-spacing: 0.12em',
      'text-transform: uppercase',
      'color: ' + theme.textSoft,
      'text-align: right',
      'padding-top: 6px',
    ].join('; ');
    this._headline.style = 'margin-top: 10px; font-size: 22px; font-weight: 700; color: #f5fbff;';
    this._subline.style = 'font-size: 13px; color: ' + theme.textSoft + ';';

    this._chipLabel.text = copy.chip;
    this._meta.text = copy.meta;
    this._headline.text = copy.headline;
    this._subline.text = copy.subline;

    this._show();
    if (noticeKey) {
      if (this._activeNoticeKey !== noticeKey || !this._hideTimerId) {
        this._activeNoticeKey = noticeKey;
        this._scheduleHide(noticeKey);
      }
    } else {
      this._activeNoticeKey = '';
      this._cancelHideTimer();
    }
  }

  destroy() {
    this._cancelHideTimer();
    if (this._monitorsChangedId) {
      Main.layoutManager.disconnect(this._monitorsChangedId);
      this._monitorsChangedId = 0;
    }
    this.actor.destroy();
  }
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

function hasFreshTrayStatus() {
  const status = readJsonFile(STATUS_FILE);
  if (!status || status.quit)
    return false;

  const updatedAt = Number(status.updatedAt || 0);
  return updatedAt > 0 && Date.now() - updatedAt < STATUS_STALE_MS;
}

function ensureAppRunning() {
  if (hasFreshTrayStatus())
    return false;

  const now = Date.now();
  if (now - _lastLaunchMs < LAUNCH_COOLDOWN_MS)
    return false;

  const launcherConfig = readJsonFile(LAUNCHER_FILE);
  const executable = String(launcherConfig?.executable || '').trim();
  const args = Array.isArray(launcherConfig?.args)
    ? launcherConfig.args.map(value => String(value || '').trim()).filter(Boolean)
    : [];

  if (!executable)
    return false;

  try {
    const launcher = new Gio.SubprocessLauncher({
      flags: Gio.SubprocessFlags.STDOUT_SILENCE | Gio.SubprocessFlags.STDERR_SILENCE,
    });
    const cwd = String(launcherConfig?.cwd || '').trim();
    if (cwd)
      launcher.set_cwd(cwd);

    const env = launcherConfig?.env && typeof launcherConfig.env === 'object'
      ? launcherConfig.env
      : {};
    for (const [key, value] of Object.entries(env)) {
      const envKey = String(key || '').trim();
      if (!envKey)
        continue;
      launcher.setenv(envKey, String(value ?? ''), true);
    }

    launcher.spawnv([executable, ...args]);
    _lastLaunchMs = now;
    return true;
  } catch (error) {
    console.error('[dictray] Failed to launch DicTray: ' + error);
    return false;
  }
}

function writeCommand(action) {
  const payload = {action, requestedAt: Date.now()};

  if (arguments.length > 1)
    payload.value = arguments[1];

  ensureAppRunning();

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

function isDicTrayWindow(win) {
  if (!win)
    return false;

  const wmClass = (win.get_wm_class?.() || '').toLowerCase();
  const wmInstance = (win.get_wm_class_instance?.() || '').toLowerCase();
  return wmClass.includes('dictray') || wmInstance.includes('dictray');
}

function findUserWindow() {
  const windows = global.get_window_actors()
    .map(a => a.get_meta_window())
    .filter(w => w
      && w.get_window_type() === Meta.WindowType.NORMAL
      && !w.is_skip_taskbar()
      && !isDicTrayWindow(w))
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
    if (!win || isDicTrayWindow(win))
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
  }
}

const DicTrayIndicator = GObject.registerClass(
class DicTrayIndicator extends PanelMenu.Button {
  constructor() {
    super(0.5, 'DicTray');
    this._state = null;
    this._menuSignature = '';
    this._overlay = new DicTrayOverlay();

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
      activateUserWindow();
      sendReturn();
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
    syncRuntimeKeybindings(next);
    const phase = String(next.phase || '').trim() || 'idle';
    const dictating = ACTIVE_PHASES.has(phase);
    this._statusDot.text = dictating ? '●' : '○';
    this._statusDot.style = dictating
      ? 'margin-right: 4px; color: #7ee787;'
      : 'margin-right: 4px; color: #9aa0a6;';
    this._title.text = ' DicTray';
    this._overlay.update(next);
    this._syncMenu(next.menu);
    _activeExtension?._syncCancelKeybinding();
  }

  _applyMissingState() {
    this._statusDot.text = '○';
    this._statusDot.style = 'margin-right: 4px; color: #9aa0a6;';
    this._title.text = ' DicTray';
    this._state = null;
    this._overlay.hideNow();
    this._syncMenu([
      {label: 'Status: waiting for app...', enabled: false},
      {type: 'separator'},
      {label: 'Target: unavailable', enabled: false},
      {label: 'Note: unavailable', enabled: false},
      {label: 'Error: none', enabled: false},
    ]);
    _activeExtension?._syncCancelKeybinding();
  }

  _applyQuitState() {
    this._statusDot.text = '○';
    this._statusDot.style = 'margin-right: 4px; color: #9aa0a6;';
    this._title.text = ' DicTray (stopped)';
    this._state = null;
    this._overlay.hideNow();
    this._syncMenu([
      {label: 'App has quit', enabled: false},
    ]);
    _activeExtension?._syncCancelKeybinding();
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
    this._overlay?.destroy();
    this._overlay = null;

    super.destroy();
  }
});

export default class DicTrayExtension extends Extension {
  constructor(metadata) {
    super(metadata);
    this._indicator = null;
    this._settings = null;
    this._lastToggleMs = 0;
    this._cancelBindingActive = false;
  }

  enable() {
    if (this._indicator)
      this._indicator.destroy();

    ensureAppRunning();
    this._lastToggleMs = 0;
    this._settings = this.getSettings(KEYBINDING_SCHEMA_ID);
    _activeExtension = this;
    this._indicator = new DicTrayIndicator();
    Main.panel.addToStatusArea(EXTENSION_ID, this._indicator, 1, 'right');

    this._bindKeybindings();
    this._syncCancelKeybinding();
  }

  disable() {
    _activeExtension = null;
    this._unbindCancelKeybinding();
    this._unbindKeybindings();
    _virtualKeyboard = null;

    if (!this._indicator)
      return;

    this._indicator.destroy();
    this._indicator = null;
  }

  _syncConfiguredKeybindings(state = null) {
    if (!this._settings || !state)
      return;

    const nextToggleBindings = hotkeyToBindings(state.hotkey);
    const nextPromptBindings = state.promptHotkey && state.promptHotkey !== state.hotkey
      ? hotkeyToBindings(state.promptHotkey)
      : [];

    const currentToggleBindings = this._settings.get_strv(KEYBINDING_TOGGLE_KEY);
    const currentPromptBindings = this._settings.get_strv(KEYBINDING_PROMPT_KEY);
    if (sameBindings(currentToggleBindings, nextToggleBindings) && sameBindings(currentPromptBindings, nextPromptBindings))
      return;

    this._settings.set_strv(KEYBINDING_TOGGLE_KEY, nextToggleBindings);
    this._settings.set_strv(KEYBINDING_PROMPT_KEY, nextPromptBindings);
    this._unbindKeybindings();
    this._bindKeybindings();
    this._syncCancelKeybinding();
  }

  _activateToggle(pressEnterAfterInsert = false) {
    const now = GLib.get_monotonic_time() / 1000;
    if (now - this._lastToggleMs < 500)
      return;

    this._lastToggleMs = now;
    const userWindow = findUserWindow();
    writeCommand('toggle', pressEnterAfterInsert ? {pressEnterAfterInsert: true} : undefined);
    if (userWindow) {
      GLib.timeout_add(GLib.PRIORITY_DEFAULT, 400, () => {
        if (isDicTrayWindow(global.display.focus_window))
          userWindow.activate(global.get_current_time());
        return GLib.SOURCE_REMOVE;
      });
    }
  }

  _shouldHandleEscape() {
    const phase = String(this._indicator?._state?.phase || '').trim() || 'idle';
    return ACTIVE_PHASES.has(phase);
  }

  _handleCancel() {
    writeCommand('cancel');
  }

  _syncCancelKeybinding() {
    if (this._shouldHandleEscape()) {
      this._bindCancelKeybinding();
      return;
    }
    this._unbindCancelKeybinding();
  }

  _bindCancelKeybinding() {
    if (this._cancelBindingActive)
      return;

    try {
      const settings = this._settings || this.getSettings(KEYBINDING_SCHEMA_ID);
      Main.wm.addKeybinding(
        KEYBINDING_CANCEL_KEY,
        settings,
        Meta.KeyBindingFlags.IGNORE_AUTOREPEAT,
        Shell.ActionMode.ALL,
        () => {
          this._handleCancel();
        },
      );
      this._cancelBindingActive = true;
    } catch (error) {
      console.error('[dictray] Failed to register cancel keybinding: ' + error);
    }
  }

  _unbindCancelKeybinding() {
    if (!this._cancelBindingActive)
      return;

    try {
      Main.wm.removeKeybinding(KEYBINDING_CANCEL_KEY);
    } catch {
    }
    this._cancelBindingActive = false;
  }

  _bindKeybindings() {
    try {
      const settings = this._settings || this.getSettings(KEYBINDING_SCHEMA_ID);
      Main.wm.addKeybinding(
        KEYBINDING_TOGGLE_KEY,
        settings,
        Meta.KeyBindingFlags.IGNORE_AUTOREPEAT,
        Shell.ActionMode.ALL,
        () => {
          this._activateToggle(false);
        },
      );
      Main.wm.addKeybinding(
        KEYBINDING_PROMPT_KEY,
        settings,
        Meta.KeyBindingFlags.IGNORE_AUTOREPEAT,
        Shell.ActionMode.ALL,
        () => {
          this._activateToggle(true);
        },
      );
    } catch (error) {
      console.error('[dictray] Failed to register keybinding: ' + error);
    }
  }

  _unbindKeybindings() {
    try {
      Main.wm.removeKeybinding(KEYBINDING_TOGGLE_KEY);
    } catch {
    }
    try {
      Main.wm.removeKeybinding(KEYBINDING_PROMPT_KEY);
    } catch {
    }
  }
}
