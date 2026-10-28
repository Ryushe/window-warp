const SHORTCUT_MODS = ["Ctrl", "Alt", "Shift", "Super"];
const SHORTCUT_KEYS = [
    ..."ABCDEFGHIJKLMNOPQRSTUVWXYZ",
    ..."0123456789",
    ...Array.from({ length: 12 }, (_, index) => `F${index + 1}`),
    "Left", "Right", "Up", "Down",
    "Space", "Tab", "Enter", "Escape", "Backspace", "Delete",
    "Insert", "Home", "End", "PageUp", "PageDown",
    "Semicolon", "Quote", "Backquote", "Comma", "Period",
    "Slash", "Backslash", "Minus", "Equal", "BracketLeft", "BracketRight"
];

function shortcutModifier(name) {
    const value = String(name || "").toLowerCase();
    if (value === "control" || value === "ctrl") return "Ctrl";
    if (value === "alt") return "Alt";
    if (value === "shift") return "Shift";
    if (value === "super" || value === "win" || value === "meta") return "Super";
    return "";
}

function parseShortcut(value) {
    const parts = String(value || "").split("+").map((part) => part.trim()).filter(Boolean);
    const key = parts.length ? parts.pop() : "";
    return { mods: new Set(parts.map(shortcutModifier).filter(Boolean)), key };
}

function formatShortcut(mods, key) {
    if (!key) return "";
    return [...SHORTCUT_MODS.filter((name) => mods.has(name)), key].join("+");
}

function readShortcutPicker(root) {
    const mods = new Set([...root.querySelectorAll("[data-mod]")].filter((button) => button.getAttribute("aria-pressed") === "true").map((button) => button.dataset.mod));
    return formatShortcut(mods, root.dataset.shortcutKey || "");
}

function syncShortcutPicker(root, value) {
    const parsed = parseShortcut(value);
    root.dataset.shortcutKey = parsed.key || "";
    root.querySelectorAll("[data-mod]").forEach((button) => {
        button.setAttribute("aria-pressed", parsed.mods.has(button.dataset.mod) ? "true" : "false");
    });
}

function watchShortcutPicker(root, onChange) {
    const update = () => onChange(readShortcutPicker(root));
    root.querySelectorAll("[data-mod]").forEach((button) => {
        button.addEventListener("click", () => {
            button.setAttribute("aria-pressed", button.getAttribute("aria-pressed") === "true" ? "false" : "true");
            update();
        });
    });
    root.querySelector(".clear-shortcut")?.addEventListener("click", () => {
        root.dataset.shortcutKey = "";
        root.querySelectorAll("[data-mod]").forEach((button) => button.setAttribute("aria-pressed", "false"));
        update();
    });
    root.querySelector("[data-field=shortcut], #quick-entry, #quick-shortcut")?.addEventListener("keydown", (event) => {
        if (event.key === "Enter" && event.target?.id === "quick-entry") return;
        if (event.key === "Escape" || ["Control", "Shift", "Alt", "Meta"].includes(event.key)) return;
        const key = String(event.code || event.key || "").replace(/^Key/, "").replace(/^Digit/, "").replace(/^Arrow/, "");
        const named = SHORTCUT_KEYS.includes(key) ? key : SHORTCUT_KEYS.includes(key.toUpperCase()) ? key.toUpperCase() : "";
        if (!named) return;
        event.preventDefault();
        root.dataset.shortcutKey = named;
        update();
    });
}
