// Bridge between the invite-code gate page and the main process.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("openswarm", {
  activate: async (code) => {
    const result = await ipcRenderer.invoke("activate", code);
    if (result && result.ok) {
      ipcRenderer.send("activation-complete");
    }
    return result;
  },
});
