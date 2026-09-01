(() => {
    const params = new URLSearchParams(location.search);
    const valueToken = params.get('valueToken');
    const message = document.getElementById('page-message');
    const saveButton = document.getElementById('save-button');
    const valueUrl = valueToken ? `${location.origin}/v/${encodeURIComponent(valueToken)}?only_value=true` : '';
    document.getElementById('value-url').value = valueUrl;
    document.getElementById('value-token').value = valueToken || '';

    function showMessage(text, success = false) {
        message.textContent = text;
        message.className = `alert ${success ? 'alert-success' : 'alert-error'}`;
        message.hidden = false;
    }

    async function request(path, options = {}) {
        const response = await fetch(path, {
            ...options,
            headers: {
                ...(options.body ? {'Content-Type': 'application/json'} : {}),
                ...(options.headers || {})
            }
        });
        if (!response.ok) throw new Error(await response.text() || `Request failed (${response.status})`);
        const type = response.headers.get('content-type') || '';
        return type.includes('application/json') ? response.json() : response.text();
    }

    async function copyValue(text, inputId, button) {
        try {
            await navigator.clipboard.writeText(text);
            const original = button.textContent;
            button.textContent = 'Copied';
            setTimeout(() => button.textContent = original, 900);
        } catch {
            document.getElementById(inputId).select();
        }
    }

    if (!valueToken) {
        showMessage('Missing valueToken in the URL.');
        saveButton.disabled = true;
        return;
    }

    request(`/v/${encodeURIComponent(valueToken)}`)
        .then(data => {
            document.getElementById('key').textContent = data.key || '(unnamed)';
            document.getElementById('description').textContent = data.description || 'No description';
            document.getElementById('value').value = data.value ?? '';
        })
        .catch(err => {
            showMessage(err.message);
            saveButton.disabled = true;
        });

    document.getElementById('value-form').addEventListener('submit', async event => {
        event.preventDefault();
        saveButton.disabled = true;
        try {
            await request(`/v/${encodeURIComponent(valueToken)}`, {
                method: 'POST',
                body: JSON.stringify({value: document.getElementById('value').value})
            });
            showMessage('Value saved.', true);
        } catch (err) {
            showMessage(err.message);
        } finally {
            saveButton.disabled = false;
        }
    });

    document.getElementById('copy-value-token').addEventListener('click', event => copyValue(valueToken, 'value-token', event.currentTarget));
    document.getElementById('copy-value-url').addEventListener('click', event => copyValue(valueUrl, 'value-url', event.currentTarget));
})();
