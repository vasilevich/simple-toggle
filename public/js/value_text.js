/* File contents remain ordinary strings; no multipart uploads or binary encoding. */
const ValueText = (() => {
    const MAX_FILE_BYTES = 1024 * 1024;

    async function readFile(file) {
        if (file.size > MAX_FILE_BYTES) throw new Error('Text files must be 1 MiB or smaller.');
        const bytes = await file.arrayBuffer();
        let text;
        try {
            // Preserve the UTF-8 BOM too; malformed input must not be silently replaced.
            text = new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}).decode(bytes);
        } catch {
            throw new Error('This is not a UTF-8 text file. Save it as UTF-8 and try again.');
        }
        if (text.includes('\0')) throw new Error('Binary files are not supported. Choose a text file.');
        return text;
    }

    function bind(field, initialValue = '') {
        const tools = document.createElement('div');
        tools.className = 'value-file-tools';
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'button button-secondary button-small';
        button.textContent = 'Load text file';
        const picker = document.createElement('input');
        picker.type = 'file';
        picker.hidden = true;
        picker.setAttribute('aria-label', 'Load value from a text file');
        const status = document.createElement('span');
        status.className = 'value-file-status';
        status.setAttribute('role', 'status');
        status.setAttribute('aria-live', 'polite');
        const hint = 'UTF-8 text, up to 1 MiB. Save to apply.';
        status.textContent = hint;
        tools.append(button, picker, status);
        (field.closest('label') || field.closest('.value-row') || field).after(tools);
        field.classList.add('value-text-input');
        field.spellcheck = false;
        field.setAttribute('wrap', 'off');
        field.setAttribute('autocapitalize', 'off');

        let original, displayed, generation = 0, loading = false;
        const setValue = value => {
            original = String(value ?? '');
            field.value = original;
            // textarea.value normalizes CRLF/CR to LF. Keep the unmodified string separately.
            displayed = field.value;
        };
        const reset = () => {
            generation++;
            loading = false;
            picker.value = '';
            status.textContent = hint;
            status.classList.remove('value-file-error');
            setValue(field.defaultValue || '');
        };
        setValue(initialValue);
        button.addEventListener('click', () => { if (!field.disabled && !field.readOnly) picker.click(); });
        field.addEventListener('input', () => {
            generation++; // An edit must win over a file that is still being read.
            loading = false;
            status.textContent = 'Edited. Save to apply.';
            status.classList.remove('value-file-error');
        });
        field.form?.addEventListener('reset', reset);
        picker.addEventListener('change', async () => {
            const file = picker.files[0];
            picker.value = ''; // Allow selecting the same file again, including after a failed read.
            if (!file || field.disabled || field.readOnly) return;
            const current = ++generation;
            loading = true;
            status.textContent = `Reading ${file.name}…`;
            status.classList.remove('value-file-error');
            try {
                const text = await readFile(file);
                if (current !== generation) return;
                setValue(text);
                status.textContent = `${file.name} loaded. Save to apply.`;
            } catch (err) {
                if (current !== generation) return;
                status.textContent = err.message || 'Unable to read this file.';
                status.classList.add('value-file-error');
            } finally {
                if (current === generation) loading = false;
            }
        });
        return {
            getValue() {
                if (loading) throw new Error('The file is still loading. Save after it has loaded.');
                return field.value === displayed ? original : field.value;
            },
            setValue(value) {
                generation++;
                loading = false;
                setValue(value);
            },
            reset
        };
    }
    return {bind, readFile, MAX_FILE_BYTES};
})();
if (typeof module !== 'undefined') module.exports = ValueText;
