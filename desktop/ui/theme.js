function themeButtonInk(hex) {
    const value = String(hex || "").replace("#", "");
    if (!/^[0-9a-f]{6}$/i.test(value)) return "#1c1b19";
    const red = parseInt(value.slice(0, 2), 16);
    const green = parseInt(value.slice(2, 4), 16);
    const blue = parseInt(value.slice(4, 6), 16);
    return (red * 299 + green * 587 + blue * 114) / 1000 > 150 ? "#1c1b19" : "#f4efe6";
}

function applyThemeDocument(name, colors, css) {
    const theme = ["warp", "dracula", "ink", "light", "custom"].includes(name) ? name : "warp";
    document.documentElement.dataset.theme = theme;
    if (colors) {
        for (const key of ["bg", "sidebar", "text", "chord", "button"]) {
            if (colors[key]) document.documentElement.style.setProperty("--custom-" + key, colors[key]);
        }
        if (colors.button) document.documentElement.style.setProperty("--custom-button-text", themeButtonInk(colors.button));
    }
    let style = document.getElementById("theme-user-css");
    const text = String(css || "").replace(/<\/style/gi, "");
    if (!style && text) {
        style = document.createElement("style");
        style.id = "theme-user-css";
        document.head.append(style);
    }
    if (style) style.textContent = text;
}

function applyStoredTheme() {
    let name = "warp";
    let colors = null;
    let css = "";
    try {
        name = localStorage.getItem("window-warp-theme") || "warp";
        colors = JSON.parse(localStorage.getItem("window-warp-theme-colors") || "null");
        css = localStorage.getItem("window-warp-theme-css") || "";
    } catch { /* the popup can still follow a theme event */ }
    applyThemeDocument(name, colors, css);
}

applyStoredTheme();
window.addEventListener("storage", (event) => {
    if (String(event.key || "").startsWith("window-warp-theme")) applyStoredTheme();
});

function listenForTheme() {
    window.__TAURI__?.event?.listen?.("warp-theme", (event) => {
        const payload = event.payload || {};
        applyThemeDocument(payload.name, payload.colors, payload.css);
    });
}
if (window.__TAURI__?.event?.listen) listenForTheme();
else document.addEventListener("DOMContentLoaded", listenForTheme);
