const finish = async apply => {
    try { await window.__TAURI__.core.invoke("finish_position", {apply}); }
    catch (error) { window.WarpErrorTimer.set(document.querySelector("#error"), String(error), {error:true}); }
};
document.querySelector("#apply").addEventListener("click", () => finish(true));
document.querySelector("#cancel").addEventListener("click", () => finish(false));
window.addEventListener("keydown", event => {
    if (event.key === "Escape" || event.key === "Enter") {
        event.preventDefault();
        finish(event.key === "Enter");
    }
});
