import { contextBridge, ipcRenderer, webFrame, webUtils } from 'electron'

// Which translucency the OS can back. Asked synchronously because the renderer
// needs it before its first paint, and answered by main because deciding it
// needs `os.release()` — a sandboxed preload may only require electron, events,
// timers and url, so importing node:os here throws before contextBridge runs
// and takes the ENTIRE bridge down with it (window.sanremesDesktop undefined =>
// "Desktop IPC bridge is unavailable"). No reply means no glass, which degrades
// to an ordinary opaque window rather than a page thinned over nothing.
const translucencySupport = ipcRenderer.sendSync('sanremes:translucency:support')
const hudWindowing = ipcRenderer.sendSync('sanremes:hud:windowing')
const hudNativeDrag = hudWindowing?.nativeDrag === true

contextBridge.exposeInMainWorld('sanremesDesktop', {
  glassSupported: translucencySupport?.glass === true,
  translucencySupported: translucencySupport?.translucency === true,
  getConnection: profile => ipcRenderer.invoke('sanremes:connection', profile),
  // Registry-scoped backend resolution: { connectionId, profile } → descriptor.
  getConnectionFor: payload => ipcRenderer.invoke('sanremes:connection:for', payload),
  getProfileRoutes: profiles => ipcRenderer.invoke('sanremes:plugin-profile-routes', profiles),
  revalidateConnection: () => ipcRenderer.invoke('sanremes:connection:revalidate'),
  touchBackend: profile => ipcRenderer.invoke('sanremes:backend:touch', profile),
  getGatewayWsUrl: profile => ipcRenderer.invoke('sanremes:gateway:ws-url', profile),
  // Registry-scoped fresh WS URL: { connectionId, profile } → result shape of
  // getGatewayWsUrl, minted against that connection's backend.
  getGatewayWsUrlFor: payload => ipcRenderer.invoke('sanremes:gateway:ws-url-for', payload),
  // Union agent roster across every registered connection.
  getAgentRoster: () => ipcRenderer.invoke('sanremes:agents:roster'),
  openSessionWindow: (sessionId, opts) => ipcRenderer.invoke('sanremes:window:openSession', sessionId, opts),
  openSessionInTerminal: (sessionId, opts) => ipcRenderer.invoke('sanremes:window:openInTerminal', sessionId, opts),
  openWindow: () => ipcRenderer.invoke('sanremes:window:openInstance'),
  openBrowserWindow: tabId => ipcRenderer.invoke('sanremes:window:openBrowser', tabId),
  onBrowserPopoutClosed: callback => {
    const listener = (_event, tabId) => callback(tabId)
    ipcRenderer.on('sanremes:browser-popout:closed', listener)

    return () => ipcRenderer.removeListener('sanremes:browser-popout:closed', listener)
  },
  claimAmbientCue: key => ipcRenderer.invoke('sanremes:ambient:claim', key),
  wakeIndicator: {
    getState: () => ipcRenderer.invoke('sanremes:wake-indicator:get'),
    setState: state => ipcRenderer.send('sanremes:wake-indicator:set', state),
    onState: callback => {
      const listener = (_event, state) => callback(state)
      ipcRenderer.on('sanremes:wake-indicator:state', listener)

      return () => ipcRenderer.removeListener('sanremes:wake-indicator:state', listener)
    }
  },
  petOverlay: {
    // Main renderer → main process: window lifecycle + drag. `request` is
    // `{ bounds, screen }`; resolves with the screen bounds it actually used.
    open: request => ipcRenderer.invoke('sanremes:pet-overlay:open', request),
    close: () => ipcRenderer.invoke('sanremes:pet-overlay:close'),
    setBounds: bounds => ipcRenderer.send('sanremes:pet-overlay:set-bounds', bounds),
    setIgnoreMouse: ignore => ipcRenderer.send('sanremes:pet-overlay:ignore-mouse', ignore),
    // Flip the overlay focusable (and focus it) while the composer needs keys.
    setFocusable: focusable => ipcRenderer.send('sanremes:pet-overlay:set-focusable', focusable),
    // Main renderer → overlay (forwarded by main): push the latest pet state.
    pushState: payload => ipcRenderer.send('sanremes:pet-overlay:state', payload),
    // Overlay → main renderer (forwarded by main): pop back in / composer submit.
    control: payload => ipcRenderer.send('sanremes:pet-overlay:control', payload),
    // Overlay subscribes to state pushes.
    onState: callback => {
      const listener = (_event, payload) => callback(payload)
      ipcRenderer.on('sanremes:pet-overlay:state', listener)

      return () => ipcRenderer.removeListener('sanremes:pet-overlay:state', listener)
    },
    // Main renderer subscribes to overlay control messages.
    onControl: callback => {
      const listener = (_event, payload) => callback(payload)
      ipcRenderer.on('sanremes:pet-overlay:control', listener)

      return () => ipcRenderer.removeListener('sanremes:pet-overlay:control', listener)
    }
  },
  // HUD mode: the chrome-free floating chat. A full app renderer (own gateway)
  // sized as a floating bar, so it mounts the real composer. Main owns the
  // window; `onChanged` keeps every window's toggle truthful.
  hud: {
    nativeDrag: hudNativeDrag,
    windowing: {
      clientPlacement: hudWindowing?.clientPlacement !== false,
      controlDrag: hudWindowing?.controlDrag === true,
      nativeDrag: hudNativeDrag,
      solid: hudWindowing?.solid === true,
      workspaceTransfer: hudWindowing?.workspaceTransfer === true
    },
    open: request => ipcRenderer.invoke('sanremes:hud:open', request),
    close: () => ipcRenderer.invoke('sanremes:hud:close'),
    setIgnoreMouse: ignore => ipcRenderer.send('sanremes:hud:ignore-mouse', ignore),
    beginMove: () => ipcRenderer.send('sanremes:hud:begin-move'),
    endMove: () => ipcRenderer.send('sanremes:hud:end-move'),
    moveBy: delta => ipcRenderer.send('sanremes:hud:move-by', delta),
    setWorkspaceTransfer: transferring => ipcRenderer.send('sanremes:hud:workspace-transfer', transferring),
    setBounds: bounds => ipcRenderer.send('sanremes:hud:set-bounds', bounds),
    resetLayout: () => ipcRenderer.invoke('sanremes:hud:reset-layout'),
    // Whether the band covers the window below the bar. Main pairs it with the
    // user's translucency setting to decide the native frost (macOS vibrancy /
    // Windows 11 DWM backdrop) — see hudFrostFor.
    setFrost: showing => ipcRenderer.invoke('sanremes:hud:frost', showing),
    // The HUD tells main which session it is on; main hands that back to the
    // app window when the HUD closes, so the app can re-home onto it.
    setSession: sessionId => ipcRenderer.send('sanremes:hud:session', sessionId),
    onGoto: callback => {
      const listener = (_event, sessionId) => callback(sessionId)
      ipcRenderer.on('sanremes:hud:goto', listener)

      return () => ipcRenderer.removeListener('sanremes:hud:goto', listener)
    },
    onChanged: callback => {
      const listener = (_event, state) => callback(state)
      ipcRenderer.on('sanremes:hud:changed', listener)

      return () => ipcRenderer.removeListener('sanremes:hud:changed', listener)
    },
    // Linux only, and silent elsewhere: where the cursor is, in page
    // coordinates, or null when it has left the window. Stands in for the
    // mousemove that `setIgnoreMouseEvents(true, { forward: true })` delivers on
    // macOS and Windows but not here.
    onCursor: callback => {
      const listener = (_event, point) => callback(point)
      ipcRenderer.on('sanremes:hud:cursor', listener)

      return () => ipcRenderer.removeListener('sanremes:hud:cursor', listener)
    },
    // Main's game-overlay watch: whether a fullscreen app (a game) is under
    // the HUD, so the renderer can step back to the low-opacity overlay
    // treatment while one owns the screen.
    onGameOverlay: callback => {
      const listener = (_event, state) => callback(state)
      ipcRenderer.on('sanremes:hud:game-overlay', listener)

      return () => ipcRenderer.removeListener('sanremes:hud:game-overlay', listener)
    }
  },
  // Quick Entry: the global-hotkey mini composer window. Main owns the OS
  // shortcut + the persisted preference; the quick window only captures text
  // and hands it back, and the primary renderer submits it through the normal
  // prompt path.
  quickEntry: {
    getSettings: () => ipcRenderer.invoke('sanremes:quick-entry:settings:get'),
    setSettings: patch => ipcRenderer.invoke('sanremes:quick-entry:settings:set', patch),
    submit: payload => ipcRenderer.send('sanremes:quick-entry:submit', payload),
    dismiss: () => ipcRenderer.send('sanremes:quick-entry:dismiss'),
    // Primary renderer → main → quick window: gateway connection state + the
    // recent-session options the target picker offers. Main caches the latest
    // payload so a freshly spawned quick window starts from truth.
    pushState: payload => ipcRenderer.send('sanremes:quick-entry:state', payload),
    // Quick window subscribes to those pushes.
    onState: callback => {
      const listener = (_event, payload) => callback(payload)
      ipcRenderer.on('sanremes:quick-entry:state', listener)

      return () => ipcRenderer.removeListener('sanremes:quick-entry:state', listener)
    },
    // Main → primary renderer: a submit captured by the quick window.
    onSubmit: callback => {
      const listener = (_event, payload) => callback(payload)
      ipcRenderer.on('sanremes:quick-entry:submit', listener)

      return () => ipcRenderer.removeListener('sanremes:quick-entry:submit', listener)
    },
    // Main → quick window: you were just summoned (reset draft + refocus).
    onShown: callback => {
      const listener = () => callback()
      ipcRenderer.on('sanremes:quick-entry:shown', listener)

      return () => ipcRenderer.removeListener('sanremes:quick-entry:shown', listener)
    }
  },
  getBootProgress: () => ipcRenderer.invoke('sanremes:boot-progress:get'),
  getConnectionConfig: profile => ipcRenderer.invoke('sanremes:connection-config:get', profile),
  saveConnectionConfig: payload => ipcRenderer.invoke('sanremes:connection-config:save', payload),
  applyConnectionConfig: payload => ipcRenderer.invoke('sanremes:connection-config:apply', payload),
  testConnectionConfig: payload => ipcRenderer.invoke('sanremes:connection-config:test', payload),
  // Opt-in OS-keychain encryption for stored gateway secrets (default off —
  // see secret-storage-policy.ts). get never touches the OS keychain.
  getSecretStorageEncryption: () => ipcRenderer.invoke('sanremes:secret-storage:get'),
  setSecretStorageEncryption: (on: boolean) => ipcRenderer.invoke('sanremes:secret-storage:set', on),
  // v2 multi-connection registry: named agent sources (local / remote / cloud / ssh).
  connections: {
    list: () => ipcRenderer.invoke('sanremes:connections:list'),
    save: payload => ipcRenderer.invoke('sanremes:connections:save', payload),
    remove: id => ipcRenderer.invoke('sanremes:connections:remove', id),
    setPrimary: id => ipcRenderer.invoke('sanremes:connections:set-primary', id),
    setLaunchMode: mode => ipcRenderer.invoke('sanremes:connections:set-launch-mode', mode),
    setLastUsed: id => ipcRenderer.invoke('sanremes:connections:set-last-used', id),
    test: id => ipcRenderer.invoke('sanremes:connections:test', id),
    updateManaged: id => ipcRenderer.invoke('sanremes:connections:update-managed', id),
    // Fan out `sanremes update` to every eligible registered connection.
    // Optional excludeIds skips rows the caller updates through another path.
    updateAll: options => ipcRenderer.invoke('sanremes:connections:update-all', options),
    // Registry lifecycle push (main → renderer): a connection was removed or
    // materially edited, so secondaries scoped to it must be disposed (and,
    // for edits, re-dialed at the new target).
    onChanged: callback => {
      const listener = (_event, payload) => callback(payload)
      ipcRenderer.on('sanremes:connections:changed', listener)

      return () => ipcRenderer.removeListener('sanremes:connections:changed', listener)
    }
  },
  sshConfigHosts: () => ipcRenderer.invoke('sanremes:ssh-config:hosts'),
  sshResolveHost: host => ipcRenderer.invoke('sanremes:ssh-config:resolve', host),
  probeConnectionConfig: remoteUrl => ipcRenderer.invoke('sanremes:connection-config:probe', remoteUrl),
  oauthLoginConnectionConfig: remoteUrl => ipcRenderer.invoke('sanremes:connection-config:oauth-login', remoteUrl),
  oauthLogoutConnectionConfig: remoteUrl => ipcRenderer.invoke('sanremes:connection-config:oauth-logout', remoteUrl),
  // SanRemes Cloud: one portal login powers discovery + silent per-agent sign-in
  // (cloud-auto-discovery Phase 3).
  cloud: {
    status: () => ipcRenderer.invoke('sanremes:cloud:status'),
    login: () => ipcRenderer.invoke('sanremes:cloud:login'),
    logout: () => ipcRenderer.invoke('sanremes:cloud:logout'),
    discover: org => ipcRenderer.invoke('sanremes:cloud:discover', org),
    agentSignIn: dashboardUrl => ipcRenderer.invoke('sanremes:cloud:agent-sign-in', dashboardUrl)
  },
  profile: {
    get: () => ipcRenderer.invoke('sanremes:profile:get'),
    remember: name => ipcRenderer.invoke('sanremes:profile:remember', name),
    set: name => ipcRenderer.invoke('sanremes:profile:set', name)
  },
  api: request => ipcRenderer.invoke('sanremes:api', request),
  notify: payload => ipcRenderer.invoke('sanremes:notify', payload),
  requestMicrophoneAccess: () => ipcRenderer.invoke('sanremes:requestMicrophoneAccess'),
  readWindowBelow: () => ipcRenderer.invoke('sanremes:window:readBelow'),
  readFileDataUrl: filePath => ipcRenderer.invoke('sanremes:readFileDataUrl', filePath),
  readFileDataUrlForAttach: filePath => ipcRenderer.invoke('sanremes:readFileDataUrlForAttach', filePath),
  dataUrlReadMax: {
    get: () => ipcRenderer.invoke('sanremes:data-url-read-max:get'),
    set: maxMb => ipcRenderer.invoke('sanremes:data-url-read-max:set', maxMb)
  },
  readFileText: filePath => ipcRenderer.invoke('sanremes:readFileText', filePath),
  readPluginSource: (filePath: string) => ipcRenderer.invoke('sanremes:readPluginSource', filePath),
  selectPaths: options => ipcRenderer.invoke('sanremes:selectPaths', options),
  selectSavePath: options => ipcRenderer.invoke('sanremes:selectSavePath', options),
  writeClipboard: text => ipcRenderer.invoke('sanremes:writeClipboard', text),
  readClipboard: () => ipcRenderer.invoke('sanremes:readClipboard'),
  saveGatewayFile: payload => ipcRenderer.invoke('sanremes:saveGatewayFile', payload),
  saveImageFromUrl: url => ipcRenderer.invoke('sanremes:saveImageFromUrl', url),
  contextMenuEdit: command => ipcRenderer.invoke('sanremes:context-menu:edit', command),
  contextMenuCopyImage: () => ipcRenderer.invoke('sanremes:context-menu:copy-image'),
  contextMenuSpellcheck: action => ipcRenderer.invoke('sanremes:context-menu:spellcheck', action),
  contextMenuGuestAddWord: payload => ipcRenderer.invoke('sanremes:context-menu:guest-add-word', payload),
  onContextMenuSpellcheck: callback => {
    const listener = (_event, payload) => callback(payload)
    ipcRenderer.on('sanremes:context-menu-spellcheck', listener)

    return () => ipcRenderer.removeListener('sanremes:context-menu-spellcheck', listener)
  },
  saveImageBuffer: (data, ext) => ipcRenderer.invoke('sanremes:saveImageBuffer', { data, ext }),
  saveClipboardImage: () => ipcRenderer.invoke('sanremes:saveClipboardImage'),
  getPathForFile: file => {
    try {
      return webUtils.getPathForFile(file) || ''
    } catch {
      return ''
    }
  },
  normalizePreviewTarget: (target, baseDir) => ipcRenderer.invoke('sanremes:normalizePreviewTarget', target, baseDir),
  watchPreviewFile: url => ipcRenderer.invoke('sanremes:watchPreviewFile', url),
  watchDirectory: dir => ipcRenderer.invoke('sanremes:watchDirectory', dir),
  stopPreviewFileWatch: id => ipcRenderer.invoke('sanremes:stopPreviewFileWatch', id),
  setActiveWork: payload => ipcRenderer.send('sanremes:active-work', payload),
  setTitleBarTheme: payload => ipcRenderer.send('sanremes:titlebar-theme', payload),
  setNativeTheme: mode => ipcRenderer.send('sanremes:native-theme', mode),
  setTranslucency: payload => ipcRenderer.send('sanremes:translucency', payload),
  setKeepAwake: on => ipcRenderer.send('sanremes:keep-awake', on),
  setDisableF12: blocked => ipcRenderer.send('sanremes:devtools:disable-f12', blocked),
  setPreviewShortcutActive: active => ipcRenderer.send('sanremes:previewShortcutActive', Boolean(active)),
  openExternal: url => ipcRenderer.invoke('sanremes:openExternal', url),
  openPreviewInBrowser: url => ipcRenderer.invoke('sanremes:openPreviewInBrowser', url),
  reachPreviewUrl: url => ipcRenderer.invoke('sanremes:preview:reach', url),
  setActiveConnectionRoute: route => ipcRenderer.send('sanremes:connection:active-route', route),
  fetchLinkTitle: url => ipcRenderer.invoke('sanremes:fetchLinkTitle', url),
  resolveFavicon: url => ipcRenderer.invoke('sanremes:resolveFavicon', url),
  sanitizeWorkspaceCwd: cwd => ipcRenderer.invoke('sanremes:workspace:sanitize', cwd),
  settings: {
    getDefaultProjectDir: () => ipcRenderer.invoke('sanremes:setting:defaultProjectDir:get'),
    setDefaultProjectDir: dir => ipcRenderer.invoke('sanremes:setting:defaultProjectDir:set', dir),
    pickDefaultProjectDir: () => ipcRenderer.invoke('sanremes:setting:defaultProjectDir:pick')
  },
  zoom: {
    // Current zoom of this window, as { level, percent }.
    get: () => ipcRenderer.invoke('sanremes:zoom:get'),
    // Synchronous zoom factor (1 = 100%). Coordinate math needs it in the
    // same tick as the event it converts, so no IPC round-trip here.
    factor: () => webFrame.getZoomFactor(),
    setPercent: percent => ipcRenderer.send('sanremes:zoom:set-percent', percent),
    // Fires on every zoom change, including the Ctrl/Cmd +/-/0 shortcuts,
    // so the settings UI can stay in sync with the keyboard.
    onChanged: callback => {
      const listener = (_event, payload) => callback(payload)
      ipcRenderer.on('sanremes:zoom:changed', listener)

      return () => ipcRenderer.removeListener('sanremes:zoom:changed', listener)
    }
  },
  revealLogs: () => ipcRenderer.invoke('sanremes:logs:reveal'),
  getRecentLogs: () => ipcRenderer.invoke('sanremes:logs:recent'),
  // Fire-and-forget: persists a renderer error-boundary catch (with component
  // stack) to desktop.log so crashes survive the window (#79428).
  reportRendererError: report => ipcRenderer.send('sanremes:logs:renderer-error', report),
  readDir: dirPath => ipcRenderer.invoke('sanremes:fs:readDir', dirPath),
  gitRoot: startPath => ipcRenderer.invoke('sanremes:fs:gitRoot', startPath),
  revealPath: targetPath => ipcRenderer.invoke('sanremes:fs:reveal', targetPath),
  openDir: dirPath => ipcRenderer.invoke('sanremes:fs:openDir', dirPath),
  desktopPluginsRoot: () => ipcRenderer.invoke('sanremes:fs:desktopPluginsRoot'),
  logsRoot: () => ipcRenderer.invoke('sanremes:fs:logsRoot'),
  agentPluginsRoot: () => ipcRenderer.invoke('sanremes:fs:agentPluginsRoot'),
  renamePath: (targetPath, newName) => ipcRenderer.invoke('sanremes:fs:rename', targetPath, newName),
  writeTextFile: (filePath, content) => ipcRenderer.invoke('sanremes:fs:writeText', filePath, content),
  trashPath: targetPath => ipcRenderer.invoke('sanremes:fs:trash', targetPath),
  git: {
    worktreeList: repoPath => ipcRenderer.invoke('sanremes:git:worktreeList', repoPath),
    worktreeAdd: (repoPath, options) => ipcRenderer.invoke('sanremes:git:worktreeAdd', repoPath, options),
    worktreeRemove: (repoPath, worktreePath, options) =>
      ipcRenderer.invoke('sanremes:git:worktreeRemove', repoPath, worktreePath, options),
    branchSwitch: (repoPath, branch) => ipcRenderer.invoke('sanremes:git:branchSwitch', repoPath, branch),
    branchList: repoPath => ipcRenderer.invoke('sanremes:git:branchList', repoPath),
    baseBranchList: repoPath => ipcRenderer.invoke('sanremes:git:baseBranchList', repoPath),
    repoStatus: repoPath => ipcRenderer.invoke('sanremes:git:repoStatus', repoPath),
    fileDiff: (repoPath, filePath) => ipcRenderer.invoke('sanremes:git:fileDiff', repoPath, filePath),
    scanRepos: (roots, options) => ipcRenderer.invoke('sanremes:git:scanRepos', roots, options),
    review: {
      list: (repoPath, scope, baseRef) => ipcRenderer.invoke('sanremes:git:review:list', repoPath, scope, baseRef),
      diff: (repoPath, filePath, scope, baseRef, staged) =>
        ipcRenderer.invoke('sanremes:git:review:diff', repoPath, filePath, scope, baseRef, staged),
      stage: (repoPath, filePath) => ipcRenderer.invoke('sanremes:git:review:stage', repoPath, filePath),
      unstage: (repoPath, filePath) => ipcRenderer.invoke('sanremes:git:review:unstage', repoPath, filePath),
      revert: (repoPath, filePath) => ipcRenderer.invoke('sanremes:git:review:revert', repoPath, filePath),
      revParse: (repoPath, ref) => ipcRenderer.invoke('sanremes:git:review:revParse', repoPath, ref),
      commit: (repoPath, message, push) => ipcRenderer.invoke('sanremes:git:review:commit', repoPath, message, push),
      commitContext: repoPath => ipcRenderer.invoke('sanremes:git:review:commitContext', repoPath),
      push: repoPath => ipcRenderer.invoke('sanremes:git:review:push', repoPath),
      shipInfo: repoPath => ipcRenderer.invoke('sanremes:git:review:shipInfo', repoPath),
      prList: (repoPath, branches, numbers) =>
        ipcRenderer.invoke('sanremes:git:review:prList', repoPath, branches, numbers),
      fetchPrComment: (repoPath, url) => ipcRenderer.invoke('sanremes:git:review:fetchPrComment', repoPath, url),
      createPr: repoPath => ipcRenderer.invoke('sanremes:git:review:createPr', repoPath)
    }
  },
  terminal: {
    cwd: id => ipcRenderer.invoke('sanremes:terminal:cwd', id),
    dispose: id => ipcRenderer.invoke('sanremes:terminal:dispose', id),
    resize: (id, size) => ipcRenderer.invoke('sanremes:terminal:resize', id, size),
    start: options => ipcRenderer.invoke('sanremes:terminal:start', options),
    write: (id, data) => ipcRenderer.invoke('sanremes:terminal:write', id, data),
    onData: (id, callback) => {
      const channel = `sanremes:terminal:${id}:data`
      const listener = (_event, payload) => callback(payload)
      ipcRenderer.on(channel, listener)

      return () => ipcRenderer.removeListener(channel, listener)
    },
    onExit: (id, callback) => {
      const channel = `sanremes:terminal:${id}:exit`
      const listener = (_event, payload) => callback(payload)
      ipcRenderer.on(channel, listener)

      return () => ipcRenderer.removeListener(channel, listener)
    }
  },
  onClosePreviewRequested: callback => {
    const listener = () => callback()
    ipcRenderer.on('sanremes:close-preview-requested', listener)

    return () => ipcRenderer.removeListener('sanremes:close-preview-requested', listener)
  },
  onPreviewNav: callback => {
    const listener = (_event, command) => callback(command)
    ipcRenderer.on('sanremes:preview-nav', listener)

    return () => ipcRenderer.removeListener('sanremes:preview-nav', listener)
  },
  onOpenFolderRequested: callback => {
    const listener = () => callback()
    ipcRenderer.on('sanremes:open-folder-requested', listener)

    return () => ipcRenderer.removeListener('sanremes:open-folder-requested', listener)
  },
  onOpenUpdatesRequested: callback => {
    const listener = () => callback()
    ipcRenderer.on('sanremes:open-updates', listener)

    return () => ipcRenderer.removeListener('sanremes:open-updates', listener)
  },
  onDeepLink: callback => {
    const listener = (_event, payload) => callback(payload)
    ipcRenderer.on('sanremes:deep-link', listener)

    return () => ipcRenderer.removeListener('sanremes:deep-link', listener)
  },
  signalDeepLinkReady: () => ipcRenderer.invoke('sanremes:deep-link-ready'),
  probePluginRepo: payload => ipcRenderer.invoke('sanremes:plugin:probe', payload),
  installDesktopPlugin: payload => ipcRenderer.invoke('sanremes:plugin:installDesktop', payload),
  onWindowStateChanged: callback => {
    const listener = (_event, payload) => callback(payload)
    ipcRenderer.on('sanremes:window-state-changed', listener)

    return () => ipcRenderer.removeListener('sanremes:window-state-changed', listener)
  },
  onFocusSession: callback => {
    const listener = (_event, sessionId) => callback(sessionId)
    ipcRenderer.on('sanremes:focus-session', listener)

    return () => ipcRenderer.removeListener('sanremes:focus-session', listener)
  },
  onNotificationAction: callback => {
    const listener = (_event, payload) => callback(payload)
    ipcRenderer.on('sanremes:notification-action', listener)

    return () => ipcRenderer.removeListener('sanremes:notification-action', listener)
  },
  onNotificationActivate: callback => {
    const listener = (_event, payload) => callback(payload)
    ipcRenderer.on('sanremes:notification-activate', listener)

    return () => ipcRenderer.removeListener('sanremes:notification-activate', listener)
  },
  onPreviewFileChanged: callback => {
    const listener = (_event, payload) => callback(payload)
    ipcRenderer.on('sanremes:preview-file-changed', listener)

    return () => ipcRenderer.removeListener('sanremes:preview-file-changed', listener)
  },
  onBackendExit: callback => {
    const listener = (_event, payload) => callback(payload)
    ipcRenderer.on('sanremes:backend-exit', listener)

    return () => ipcRenderer.removeListener('sanremes:backend-exit', listener)
  },
  // Soft gateway-mode apply finished tearing down the primary backend. Renderer
  // should wipe session lists + re-dial without a window reload.
  onConnectionApplied: callback => {
    const listener = () => callback()
    ipcRenderer.on('sanremes:connection:applied', listener)

    return () => ipcRenderer.removeListener('sanremes:connection:applied', listener)
  },
  onPowerResume: callback => {
    const listener = () => callback()
    ipcRenderer.on('sanremes:power-resume', listener)

    return () => ipcRenderer.removeListener('sanremes:power-resume', listener)
  },
  // AC ↔ battery transitions; renderers slow their backstop polls on battery.
  getOnBattery: () => ipcRenderer.invoke('sanremes:power-battery:get'),
  onBatteryChanged: callback => {
    const listener = (_event, onBattery) => callback(Boolean(onBattery))
    ipcRenderer.on('sanremes:power-battery', listener)

    return () => ipcRenderer.removeListener('sanremes:power-battery', listener)
  },
  onBootProgress: callback => {
    const listener = (_event, payload) => callback(payload)
    ipcRenderer.on('sanremes:boot-progress', listener)

    return () => ipcRenderer.removeListener('sanremes:boot-progress', listener)
  },
  // First-launch bootstrap progress -- emitted by the install.ps1 stage
  // runner in main.ts (apps/desktop/electron/bootstrap-runner.ts).
  // Renderer's install overlay subscribes to live events and queries the
  // current snapshot via getBootstrapState() to recover after a devtools
  // reload mid-bootstrap.
  getBootstrapState: () => ipcRenderer.invoke('sanremes:bootstrap:get'),
  continueBootstrapLocal: () => ipcRenderer.invoke('sanremes:bootstrap:continue-local'),
  resetBootstrap: () => ipcRenderer.invoke('sanremes:bootstrap:reset'),
  repairBootstrap: () => ipcRenderer.invoke('sanremes:bootstrap:repair'),
  cancelBootstrap: () => ipcRenderer.invoke('sanremes:bootstrap:cancel'),
  onBootstrapEvent: callback => {
    const listener = (_event, payload) => callback(payload)
    ipcRenderer.on('sanremes:bootstrap:event', listener)

    return () => ipcRenderer.removeListener('sanremes:bootstrap:event', listener)
  },
  getVersion: () => ipcRenderer.invoke('sanremes:version'),
  getRemoteDisplayReason: () => ipcRenderer.invoke('sanremes:get-remote-display-reason'),
  uninstall: {
    summary: () => ipcRenderer.invoke('sanremes:uninstall:summary'),
    run: mode => ipcRenderer.invoke('sanremes:uninstall:run', { mode })
  },
  updates: {
    check: () => ipcRenderer.invoke('sanremes:updates:check'),
    apply: opts => ipcRenderer.invoke('sanremes:updates:apply', opts),
    getBranch: () => ipcRenderer.invoke('sanremes:updates:branch:get'),
    setBranch: name => ipcRenderer.invoke('sanremes:updates:branch:set', name),
    onProgress: callback => {
      const listener = (_event, payload) => callback(payload)
      ipcRenderer.on('sanremes:updates:progress', listener)

      return () => ipcRenderer.removeListener('sanremes:updates:progress', listener)
    }
  },
  themes: {
    fetchMarketplace: id => ipcRenderer.invoke('sanremes:vscode-theme:fetch', id),
    searchMarketplace: query => ipcRenderer.invoke('sanremes:vscode-theme:search', query)
  },
  // Find-in-page (Ctrl/Cmd+F): delegates to Electron's
  // webContents.findInPage on the IPC sender's window so a Cmd+F pressed
  // in a secondary session window searches THAT window, not the primary.
  // `onFoundInPage` returns the unsubscribe fn; the renderer wires it via
  // `initFindInPageListener` in store/find-in-page.ts and tears it down
  // when the FindBar unmounts.
  findInPage: (query, options) => ipcRenderer.invoke('sanremes:find-in-page', query, options),
  stopFindInPage: () => ipcRenderer.invoke('sanremes:stop-find-in-page'),
  onFoundInPage: callback => {
    const listener = (_event, result) => callback(result)
    ipcRenderer.on('sanremes:found-in-page', listener)

    return () => ipcRenderer.removeListener('sanremes:found-in-page', listener)
  },
  // Main-process `before-input-event` forwards Ctrl/Cmd+F here so renderer
  // can open the FindBar even when the GTK compositor has already grabbed
  // the chord at the windowing layer (#81727).
  onOpenFindBarRequested: callback => {
    const listener = () => callback()
    ipcRenderer.on('sanremes:open-find-bar', listener)

    return () => ipcRenderer.removeListener('sanremes:open-find-bar', listener)
  }
})
