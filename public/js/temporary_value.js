(() => {
    const form = document.getElementById('temporary-value-form');
    if (!form) return;
    const editor = ValueText.bind(document.getElementById('value'));
    const button = form.querySelector('button[type="submit"]');
    const message = document.getElementById('value-message');
    let saving = false;
    form.addEventListener('submit', async event => {
        event.preventDefault();
        if (saving) return;
        saving = true;
        button.disabled = true;
        message.hidden = true;
        try {
            const response = await fetch(form.action, {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({value: editor.getValue()})
            });
            const data = await response.json();
            if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
            form.hidden = true;
            message.textContent = 'Value saved. This one-time link is now permanently invalid.';
        } catch (err) {
            message.textContent = err.message || 'Unable to save the value.';
        } finally {
            message.hidden = false;
            button.disabled = false;
            saving = false;
        }
    });
})();
