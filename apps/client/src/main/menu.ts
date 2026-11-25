import { Menu, type MenuItemConstructorOptions } from 'electron';
import type { Route } from '../shared/routes';

export function buildMenu({ navigate, isDev, paused, setPaused }: { navigate: (r: Route) => void; isDev: boolean; paused: boolean; setPaused: (p: boolean) => void }): Menu {
  const mac = process.platform === 'darwin';
  const template: MenuItemConstructorOptions[] = [
    ...(mac ? [{ role: 'appMenu' as const }] : []),
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { label: 'Store', accelerator: 'CmdOrCtrl+1', click: () => navigate({ name: 'store' }) },
        { label: 'Library', accelerator: 'CmdOrCtrl+2', click: () => navigate({ name: 'library' }) },
        { label: 'Activity', accelerator: 'CmdOrCtrl+3', click: () => navigate({ name: 'activity' }) },
        { label: 'Community', accelerator: 'CmdOrCtrl+4', click: () => navigate({ name: 'community' }) },
        { label: 'Wallet', accelerator: 'CmdOrCtrl+5', click: () => navigate({ name: 'wallet' }) },
        { type: 'separator' },
        { label: 'Settings', accelerator: 'CmdOrCtrl+,', click: () => navigate({ name: 'settings' }) },
        { type: 'separator' },
        ...(isDev ? [{ role: 'reload' as const }, { role: 'toggleDevTools' as const }, { type: 'separator' as const }] : []),
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Node',
      submenu: [
        { label: 'Open Activity', click: () => navigate({ name: 'activity' }) },
        // SPEC 4.1: Pause is always reachable, here and in the tray.
        { label: paused ? 'Resume node' : 'Pause node', accelerator: 'CmdOrCtrl+Shift+P', click: () => setPaused(!paused) },
        { label: 'Node settings', click: () => navigate({ name: 'settings' }) },
      ],
    },
    { role: 'windowMenu' },
    { label: 'Help', submenu: [{ label: 'Settings and updates', click: () => navigate({ name: 'settings' }) }] },
  ];
  return Menu.buildFromTemplate(template);
}
