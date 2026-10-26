const native = window.__TAURI__;
let current = null, revision = 0;
const svg = (name, attrs, text) => {
    const node = document.createElementNS("http://www.w3.org/2000/svg", name);
    for (const [key,value] of Object.entries(attrs)) node.setAttribute(key, value);
    if (text !== undefined) node.textContent = text;
    return node;
};
function render(view) {
    current = view;
    const slots = document.querySelector("#slots");
    slots.replaceChildren();
    if (!view) return;
    const count = view.labels.length, radius = count <= 4 ? 64 : 100;
    const width = count <= 4 ? 104 : 84, height = count <= 4 ? 42 : 34;
    view.labels.forEach((label, index) => {
        const angle = -Math.PI / 2 + index * 2 * Math.PI / count;
        // Compact the outer labels so all eight remain separate within 260px.
        const x = Math.max(width/2+1, Math.min(259-width/2, 130 + radius * Math.cos(angle)));
        let y = 130 + radius * Math.sin(angle);
        if (count > 4 && index === 0) y = 18;
        if (count > 4 && index === count/2) y = 242;
        const group = svg("g", {role:"option", "aria-label":label, "aria-selected":view.selected === index, class:view.selected === index ? "selected" : ""});
        group.append(svg("title", {}, label), svg("rect", {x:x-width/2,y:y-height/2,width,height}));
        const compact = label.trim().replace(/\s+/g," ");
        const letters = Array.from(compact);
        const limit = count > 4 ? 23 : 30;
        const short = letters.length > limit ? letters.slice(0,limit-1).join("") + "…" : compact;
        group.append(svg("text", {x,y:y-6}, `${index+1}. ${short.slice(0,count > 4 ? 10 : 13)}`), svg("text", {x,y:y+9}, short.slice(count > 4 ? 10 : 13)));
        slots.append(group);
    });
}
document.addEventListener("keydown", event => {
    if (event.key === "Escape" && current) {
        event.preventDefault();
        native.core.invoke("cancel_radial", {id:current.id}).catch(console.error);
    }
});
(async () => {
    await native.event.listen("radial-view", event => { revision++; render(event.payload); });
    const initialRevision = revision;
    const initial = await native.core.invoke("radial_view");
    if (revision === initialRevision) render(initial);
})().catch(console.error);
