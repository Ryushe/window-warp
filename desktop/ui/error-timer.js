/* Timed error feedback shared by the main window and its smaller editors. */
(() => {
    const duration = 6000;
    const timers = new WeakMap();

    function cancel(element) {
        const state = timers.get(element);
        if (!state) return;
        clearTimeout(state.timeout);
        element.removeEventListener("pointerenter", state.enter);
        element.removeEventListener("pointerleave", state.leave);
        element.removeEventListener("focusin", state.focus);
        element.removeEventListener("focusout", state.blur);
        element.classList.remove("timed-error", "timer-paused");
        if (state.addedTabIndex && element.getAttribute("tabindex") === "0") element.removeAttribute("tabindex");
        timers.delete(element);
    }

    function start(element, dismiss) {
        cancel(element);
        const state = {remaining:duration, started:0, timeout:null, pointer:false, focused:element.contains(document.activeElement), text:element.textContent};
        const pause = () => {
            if (state.timeout === null) return;
            clearTimeout(state.timeout);
            state.timeout = null;
            state.remaining = Math.max(0, state.remaining - (Date.now() - state.started));
            element.classList.add("timer-paused");
        };
        const resume = () => {
            if (state.pointer || state.focused || state.timeout !== null) return;
            state.started = Date.now();
            element.classList.remove("timer-paused");
            state.timeout = setTimeout(() => {
                if (timers.get(element) !== state) return;
                const unchanged = element.textContent === state.text;
                cancel(element);
                if (unchanged) dismiss();
            }, state.remaining);
        };
        state.enter = () => { state.pointer = true; pause(); };
        state.leave = () => { state.pointer = false; resume(); };
        state.focus = () => { state.focused = true; pause(); };
        state.blur = event => { state.focused = element.contains(event.relatedTarget); resume(); };
        state.addedTabIndex = !element.hasAttribute("tabindex") && !element.querySelector("button, input, select, textarea, a[href]");
        if (state.addedTabIndex) element.setAttribute("tabindex", "0");
        element.addEventListener("pointerenter", state.enter);
        element.addEventListener("pointerleave", state.leave);
        element.addEventListener("focusin", state.focus);
        element.addEventListener("focusout", state.blur);
        timers.set(element, state);
        element.style.setProperty("--error-duration", `${duration}ms`);
        // Restart the progress animation when a new error replaces an old one.
        void element.offsetWidth;
        element.classList.add("timed-error");
        if (state.focused) element.classList.add("timer-paused");
        resume();
    }

    function set(element, text, {error = false, hideWhenEmpty = false} = {}) {
        cancel(element);
        element.textContent = text || "";
        element.classList.toggle("error", !!error && !!text);
        if (hideWhenEmpty) element.hidden = !text;
        if (error && text) start(element, () => {
            element.textContent = "";
            element.classList.remove("error");
            if (hideWhenEmpty) element.hidden = true;
        });
    }

    window.WarpErrorTimer = {start, cancel, set};
})();
