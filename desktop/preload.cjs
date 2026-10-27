// The only bridge between the window and the app: read state, run an action, hear about changes.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("uwu", {
  state: () => ipcRenderer.invoke("state"),
  act: (name, arg) => ipcRenderer.invoke("act", name, arg),
  onState: (fn) => ipcRenderer.on("state", (_e, state) => fn(state)),
});
