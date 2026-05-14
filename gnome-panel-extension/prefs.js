import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences, gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const PANEL_DIR = GLib.get_user_config_dir() + '/dictray/gnome-panel';
const STATUS_FILE = PANEL_DIR + '/status.json';
const COMMAND_FILE = PANEL_DIR + '/command.json';
const LAUNCHER_FILE = PANEL_DIR + '/launcher.json';
const STATUS_STALE_MS = 45000;

function readJsonFile(filePath) {
  const file = Gio.File.new_for_path(filePath);
  if (!file.query_exists(null))
    return null;

  try {
    const [, bytes] = file.load_contents(null);
    if (!bytes)
      return null;

    const payload = JSON.parse(new TextDecoder().decode(bytes));
    return payload && typeof payload === 'object' ? payload : null;
  } catch {
    return null;
  }
}

function writeJsonFile(filePath, payload) {
  try {
    GLib.mkdir_with_parents(GLib.path_get_dirname(filePath), 0o755);
    GLib.file_set_contents(filePath, JSON.stringify(payload));
    return true;
  } catch {
    return false;
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
    return;

  const launcherConfig = readJsonFile(LAUNCHER_FILE);
  const executable = String(launcherConfig?.executable || '').trim();
  const args = Array.isArray(launcherConfig?.args)
    ? launcherConfig.args.map(value => String(value || '').trim()).filter(Boolean)
    : [];

  if (!executable)
    return;

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
      if (envKey)
        launcher.setenv(envKey, String(value ?? ''), true);
    }

    launcher.spawnv([executable, ...args]);
  } catch {
  }
}

function writeCommand(command = {}) {
  const action = String(command?.action || '').trim();
  if (!action)
    return;

  ensureAppRunning();
  writeJsonFile(COMMAND_FILE, {
    ...command,
    action,
    requestedAt: Date.now(),
  });
}

function findMenuItem(menu = [], label = '') {
  const target = String(label || '').trim();
  return (Array.isArray(menu) ? menu : []).find(item => String(item?.label || '').trim() === target) || null;
}

function findCommandItem(menu = [], action = '') {
  const target = String(action || '').trim();
  for (const item of Array.isArray(menu) ? menu : []) {
    if (String(item?.command?.action || '').trim() === target)
      return item;
    if (Array.isArray(item?.submenu)) {
      const child = findCommandItem(item.submenu, target);
      if (child)
        return child;
    }
  }
  return null;
}

function commandOptions(menu = [], action = '') {
  const target = String(action || '').trim();
  return (Array.isArray(menu) ? menu : [])
    .filter(item => item?.enabled !== false && String(item?.command?.action || '').trim() === target)
    .map(item => ({
      label: String(item?.label || '').trim(),
      value: item?.command?.value,
      checked: Boolean(item?.checked),
      command: item.command,
    }));
}

function legacyPreferencesFromMenu(status = {}) {
  const menu = Array.isArray(status.menu) ? status.menu : [];
  const duckingMenu = findMenuItem(menu, 'Output Ducking')?.submenu || [];
  const inputMenu = findMenuItem(menu, 'Input Source')?.submenu || [];
  const rewriteProviderMenu = findMenuItem(menu, 'Text Improvement Provider')?.submenu || [];
  const rewriteModelMenu = findMenuItem(menu, 'Text Improvement Model')?.submenu || [];
  const rewriteThinkMenu = findMenuItem(menu, 'Text Improvement Thinking')?.submenu || [];
  const rewriteTemperatureMenu = findMenuItem(menu, 'Text Improvement Temperature')?.submenu || [];
  const quickStartItem = findCommandItem(menu, 'open_quick_start');

  return {
    quickStart: {
      label: String(quickStartItem?.label || 'Open Quick Start').trim(),
      command: quickStartItem?.command || {action: 'open_quick_start'},
    },
    inputSource: {
      options: commandOptions(inputMenu, 'set_input_source'),
      setupCommand: findCommandItem(inputMenu, 'open_input_preview')?.command || {action: 'open_input_preview'},
      refreshCommand: findCommandItem(inputMenu, 'refresh_inputs')?.command || {action: 'refresh_inputs'},
    },
    ducking: {
      enabled: Boolean(status.duckingEnabled),
      options: commandOptions(duckingMenu, 'set_ducking_level'),
      enabledCommand: findCommandItem(duckingMenu, 'set_ducking_enabled')?.command || {
        action: 'set_ducking_enabled',
        value: !Boolean(status.duckingEnabled),
      },
    },
    nearbyDucking: {
      enabled: false,
      paired: false,
      status: _('Unavailable'),
      enabledCommand: {action: 'set_nearby_ducking_enabled', value: true},
      hostCommand: {action: 'start_nearby_pairing'},
      connectCommand: {action: 'connect_nearby_pairing'},
      forgetCommand: null,
    },
    stt: {
      supported: true,
      templateSupported: true,
      deviceOptions: commandOptions(findMenuItem(menu, 'Speech to Text Device')?.submenu, 'set_stt_device'),
      modelOptions: commandOptions(findMenuItem(menu, 'Speech to Text Model')?.submenu, 'set_stt_model'),
      templateOptions: commandOptions(findMenuItem(menu, 'Speech to Text Template')?.submenu, 'set_stt_prompt_template'),
    },
    rewrite: {
      enabled: Boolean(status.rewriteEnabled),
      enabledCommand: findCommandItem(menu, 'set_rewrite_enabled')?.command || {
        action: 'set_rewrite_enabled',
        value: !Boolean(status.rewriteEnabled),
      },
      providerOptions: commandOptions(rewriteProviderMenu, 'set_rewrite_provider'),
      modelOptions: commandOptions(rewriteModelMenu, 'switch_rewrite_model'),
      thinkOptions: commandOptions(rewriteThinkMenu, 'set_rewrite_think'),
      temperatureOptions: commandOptions(rewriteTemperatureMenu, 'set_rewrite_temperature'),
    },
    shortcuts: {
      hotkeyManagedByEnv: false,
      shortcutModeOptions: commandOptions(findMenuItem(menu, 'Shortcut Mode')?.submenu, 'set_shortcut_mode'),
      hotkeyOptions: commandOptions(findMenuItem(menu, 'Dictation Shortcut')?.submenu, 'set_tray_hotkey'),
      promptHotkeyOptions: commandOptions(findMenuItem(menu, 'Submit Shortcut (with Enter)')?.submenu, 'set_prompt_hotkey'),
    },
  };
}

function currentOptionIndex(options = []) {
  const index = (Array.isArray(options) ? options : []).findIndex(option => Boolean(option?.checked));
  return index >= 0 ? index : 0;
}

function labelsForOptions(options = []) {
  const labels = (Array.isArray(options) ? options : [])
    .map(option => String(option?.label || '').trim())
    .filter(Boolean);
  return labels.length ? labels : [_('Unavailable')];
}

function addCommandCombo(group, title, subtitle, options = []) {
  const choices = (Array.isArray(options) ? options : [])
    .filter(option => option?.command && option?.label);
  const row = new Adw.ComboRow({
    title,
    subtitle,
    model: Gtk.StringList.new(labelsForOptions(choices)),
    selected: currentOptionIndex(choices),
    sensitive: choices.length > 0,
  });

  row.connect('notify::selected', () => {
    const choice = choices[row.get_selected()];
    if (choice?.command)
      writeCommand(choice.command);
  });

  group.add(row);
  return row;
}

function addSwitchRow(group, title, subtitle, active, command) {
  const row = new Adw.SwitchRow({
    title,
    subtitle,
    active: Boolean(active),
    sensitive: Boolean(command?.action),
  });

  row.connect('notify::active', () => {
    if (!command?.action)
      return;

    writeCommand({
      ...command,
      value: row.get_active(),
    });
  });

  group.add(row);
  return row;
}

function addButtonRow(group, title, subtitle, label, command, styleClass = '') {
  const row = new Adw.ActionRow({title, subtitle});
  const button = new Gtk.Button({
    label,
    valign: Gtk.Align.CENTER,
  });
  if (styleClass)
    button.add_css_class(styleClass);

  button.connect('clicked', () => {
    writeCommand(command);
  });
  row.add_suffix(button);
  row.set_activatable_widget(button);
  group.add(row);
  return row;
}

function statusSubtitle(status = {}) {
  const phase = String(status.phaseLabel || status.phase || '').trim() || _('Waiting for DicTray');
  const error = String(status.error || '').trim();
  const note = String(status.note || '').trim();
  if (error)
    return error;
  if (note)
    return note;
  return phase;
}

export default class DicTrayPreferences extends ExtensionPreferences {
  fillPreferencesWindow(window) {
    ensureAppRunning();
    const status = readJsonFile(STATUS_FILE) || {};
    const preferences = status.preferences && typeof status.preferences === 'object'
      ? status.preferences
      : legacyPreferencesFromMenu(status);

    window.set_title(_('DicTray Preferences'));
    window.set_default_size(620, 720);

    const page = new Adw.PreferencesPage({
      title: _('DicTray'),
      icon_name: 'audio-input-microphone-symbolic',
    });
    window.add(page);

    const statusGroup = new Adw.PreferencesGroup({
      title: _('Status'),
      description: statusSubtitle(status),
    });
    page.add(statusGroup);
    addButtonRow(
      statusGroup,
      _('Quick Start'),
      _('Run the setup flow for profile, typing benchmark, speech effort, and context.'),
      String(preferences.quickStart?.label || _('Open Quick Start')),
      preferences.quickStart?.command || {action: 'open_quick_start'},
      preferences.quickStart?.completed ? '' : 'suggested-action'
    );

    const inputGroup = new Adw.PreferencesGroup({
      title: _('Input'),
      description: preferences.inputSource?.error || _('Choose the microphone and local speech runtime.'),
    });
    page.add(inputGroup);
    addCommandCombo(inputGroup, _('Microphone'), preferences.inputSource?.activeLabel || '', preferences.inputSource?.options);
    addButtonRow(inputGroup, _('Microphone Setup'), _('Open the GNOME-native input meter and selector.'), _('Open'), preferences.inputSource?.setupCommand || {action: 'open_input_preview'});
    addButtonRow(inputGroup, _('Refresh Inputs'), _('Ask DicTray to rescan available Linux audio sources.'), _('Refresh'), preferences.inputSource?.refreshCommand || {action: 'refresh_inputs'});
    addCommandCombo(inputGroup, _('Speech to Text Device'), preferences.stt?.supported === false ? _('Not available for this provider') : '', preferences.stt?.deviceOptions);
    addCommandCombo(inputGroup, _('Speech to Text Model'), preferences.stt?.supported === false ? _('Not available for this provider') : '', preferences.stt?.modelOptions);
    addCommandCombo(inputGroup, _('Speech to Text Template'), preferences.stt?.templateSupported === false ? _('Only available for local Speech to Text') : '', preferences.stt?.templateOptions);

    const outputGroup = new Adw.PreferencesGroup({
      title: _('Output'),
      description: _('Tune audio ducking and optional text improvement.'),
    });
    page.add(outputGroup);
    addSwitchRow(outputGroup, _('Output Ducking'), _('Lower system volume while recording.'), preferences.ducking?.enabled, preferences.ducking?.enabledCommand);
    addCommandCombo(outputGroup, _('Ducking Level'), '', preferences.ducking?.options);
    addSwitchRow(outputGroup, _('Nearby Ducking'), preferences.nearbyDucking?.status || _('LAN-only ducking for another DicTray device.'), preferences.nearbyDucking?.enabled, preferences.nearbyDucking?.enabledCommand);
    addButtonRow(outputGroup, _('Show Pairing Code'), _('Host pairing on this device and copy the short code.'), _('Show Code'), preferences.nearbyDucking?.hostCommand || {action: 'start_nearby_pairing'});
    addButtonRow(outputGroup, _('Connect with Code'), _('Enter the short code shown on another DicTray device.'), _('Connect'), preferences.nearbyDucking?.connectCommand || {action: 'connect_nearby_pairing'});
    if (preferences.nearbyDucking?.paired && preferences.nearbyDucking?.forgetCommand)
      addButtonRow(outputGroup, _('Forget Paired Device'), _('Remove the stored nearby ducking secret from this device.'), _('Forget'), preferences.nearbyDucking.forgetCommand, 'destructive-action');
    addSwitchRow(outputGroup, _('Improve Text'), _('Clean up raw speech before insertion.'), preferences.rewrite?.enabled, preferences.rewrite?.enabledCommand);
    addCommandCombo(outputGroup, _('Text Improvement Provider'), '', preferences.rewrite?.providerOptions);
    addCommandCombo(outputGroup, _('Text Improvement Model'), '', preferences.rewrite?.modelOptions);
    addCommandCombo(outputGroup, _('Text Improvement Thinking'), '', preferences.rewrite?.thinkOptions);
    addCommandCombo(outputGroup, _('Text Improvement Temperature'), '', preferences.rewrite?.temperatureOptions);

    const shortcutGroup = new Adw.PreferencesGroup({
      title: _('Shortcuts'),
      description: preferences.shortcuts?.hotkeyManagedByEnv
        ? _('The main shortcut is managed by DICTATION_TRAY_HOTKEY.')
        : _('Choose the GNOME Shell shortcuts DicTray should register.'),
    });
    page.add(shortcutGroup);
    addCommandCombo(shortcutGroup, _('Shortcut Mode'), '', preferences.shortcuts?.shortcutModeOptions);
    addCommandCombo(shortcutGroup, _('Dictation Shortcut'), '', preferences.shortcuts?.hotkeyOptions);
    addCommandCombo(shortcutGroup, _('Submit Shortcut'), _('Stops dictation and presses Enter after insertion.'), preferences.shortcuts?.promptHotkeyOptions);
  }
}
