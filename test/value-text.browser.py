"""Focused browser tests for the real value-editor scripts, with a mocked HTTP API."""
import re
import shutil
import subprocess
import unittest
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
TEXT = '\ufeff  first\r\n\tשלום 한글 😀\n\r\nlast  \r\n'


class ValueTextBrowserTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.playwright = sync_playwright().start()
        cls.browser = cls.playwright.chromium.launch(executable_path=shutil.which('chromium'), args=['--no-sandbox'])
        cls.temp_html = subprocess.check_output(['node', '-e', '''
            const fs = require('fs'), vm = require('vm');
            const source = fs.readFileSync('app/index.js', 'utf8');
            const renderer = source.slice(source.indexOf('const escapeHtml ='), source.indexOf('const getTemporaryLink ='));
            process.stdout.write(vm.runInNewContext(renderer + ';temporaryPage({title:"Set value",code:"one-use",key:"file"})'));
        '''], cwd=ROOT).decode()

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.playwright.stop()

    def setUp(self):
        self.context = self.browser.new_context()
        self.context.set_default_timeout(5000)
        self.page = self.context.new_page()
        self.errors = []
        self.page.on('pageerror', lambda error: self.errors.append(str(error)))

    def tearDown(self):
        self.context.close()
        self.assertEqual(self.errors, [])

    @property
    def posts(self):
        return self.page.evaluate('window.posts || []')

    def load(self, kind):
        # Offline DOM fixture: no browser navigation or external network is required.
        stored = self.page.evaluate('window.stored ?? null')
        posts = self.posts
        html = self.temp_html if kind == 'temporary' else (ROOT / 'public' / ('index.html' if kind == 'dashboard' else 'bot_value_set.html')).read_text()
        html = re.sub(r'<script\b[^>]*>.*?</script>', '', html, flags=re.S)
        html = re.sub(r'<link\b[^>]*>|<iframe\b.*?</iframe>', '', html, flags=re.S)
        html = html.replace('<head>', '<head><base href="http://localhost/">', 1)
        self.page.set_content(html)
        self.page.add_style_tag(content='[hidden]{display:none!important}.tab-panel:not(.active){display:none}' + (ROOT / 'public/css/value_text.css').read_text())
        self.page.evaluate("""({stored, posts}) => {
            window.stored = stored; window.posts = posts;
            window.fetch = async (url, options = {}) => {
                const path = new URL(url, 'http://localhost').pathname;
                const item = {key:'file', token:'value', botName:'test', value:window.stored, status:true};
                let result;
                if (options.method === 'POST') {
                    const body = JSON.parse(options.body);
                    window.posts.push([path, body]);
                    if ('value' in body) window.stored = body.value;
                    result = {status:'success', consumed:true};
                } else if (path === '/bot/values') result = [item];
                else if (path === '/v/value') result = item;
                else result = [];
                return new Response(JSON.stringify(result), {headers:{'Content-Type':'application/json'}});
            };
        }""", dict(stored=TEXT if stored is None else stored, posts=posts))
        self.page.evaluate("source => {window.ValueText = new Function(source + ';return ValueText;')();}", (ROOT / 'public/js/value_text.js').read_text())
        script = {'dashboard':'index.js', 'permanent':'bot_value_set.js', 'temporary':'temporary_value.js'}[kind]
        self.page.evaluate("""({source, kind}) => {
            const location = {origin:'http://localhost', pathname:'/', hash:'', search:kind === 'dashboard' ? '?token=admin' : '?valueToken=value'};
            new Function('location', 'history', source)(location, {replaceState() {}});
        }""", dict(source=(ROOT / 'public/js' / script).read_text(), kind=kind))

    def dashboard(self):
        self.load('dashboard')
        self.page.locator('[data-tab="values"]').click()
        self.page.locator('#value-control-panel .value-input').wait_for()

    def upload(self, scope, data=TEXT.encode(), name='settings.txt'):
        scope.locator('input[type=file]').set_input_files(dict(name=name, mimeType='text/plain', buffer=data))
        self.page.wait_for_function("!Array.from(document.querySelectorAll('.value-file-status')).some(el => el.textContent.startsWith('Reading '))")

    def test_existing_value_resave_preserves_original_line_endings(self):
        self.dashboard()
        self.page.locator('#value-control-panel .save-value').click()
        self.page.wait_for_function("document.querySelector('.save-value').textContent === 'Saved'")
        self.assertEqual(self.posts[-1][1]['value'], TEXT)

    def test_dashboard_file_and_reload(self):
        self.dashboard()
        large = TEXT + 'x' * 200000
        card = self.page.locator('#value-control-panel .control-card')
        self.upload(card, large.encode())
        self.assertEqual(self.posts, [])  # Selecting a file does not save it.
        card.locator('.save-value').click()
        self.page.wait_for_function("document.querySelector('.save-value').textContent === 'Saved'")
        self.assertEqual(self.posts[-1][1]['value'], large)
        self.load('dashboard')
        self.page.locator('[data-tab="values"]').click()
        self.page.locator('#value-control-panel .save-value').click()
        self.page.wait_for_function("document.querySelector('.save-value').textContent === 'Saved'")
        self.assertEqual(self.posts[-1][1]['value'], large)

    def test_create_and_form_reset(self):
        self.dashboard()
        self.page.locator('#open-create-value').click()
        form = self.page.locator('#create-value-form')
        form.locator('#value-key-input').fill('from-file')
        self.upload(form)
        form.get_by_role('button', name='Create value', exact=True).click()
        self.page.locator('#create-value-modal').wait_for(state='hidden')
        self.assertEqual(self.posts[-1][1]['value'], TEXT)
        self.page.locator('#open-create-value').click()
        form.locator('#value-key-input').fill('empty')
        form.get_by_role('button', name='Create value', exact=True).click()
        self.page.locator('#create-value-modal').wait_for(state='hidden')
        self.assertEqual(self.posts[-1][1]['value'], '')

    def test_permanent_page(self):
        self.load('permanent')
        self.page.wait_for_function("!document.getElementById('save-button').disabled")
        form = self.page.locator('#value-form')
        self.upload(form)
        self.page.locator('#save-button').click()
        self.page.locator('#page-message').filter(has_text='Value saved.').wait_for()
        self.assertEqual(self.posts[-1][1]['value'], TEXT)

    def test_one_time_page(self):
        self.load('temporary')
        form = self.page.locator('#temporary-value-form')
        self.upload(form)
        form.locator('button[type=submit]').click()
        form.wait_for(state='hidden')
        self.assertEqual(self.posts[-1], ['/t/one-use', {'value': TEXT}])

    def test_bad_file_leaves_old_value_and_same_file_can_be_reselected(self):
        self.dashboard()
        card = self.page.locator('#value-control-panel .control-card')
        for bad in [b'\xc3(', b'a\0b', b'x' * (1024 * 1024 + 1)]:
            self.upload(card, bad)
            card.locator('.value-file-error').wait_for()
            self.assertEqual(card.locator('textarea').input_value(), TEXT.replace('\r\n', '\n'))
        self.upload(card, b'', 'settings.txt')
        card.locator('.save-value').click()
        self.page.wait_for_function("document.querySelector('.save-value').textContent === 'Saved'")
        self.assertEqual(self.posts[-1][1]['value'], '')

    def test_user_edit_wins_over_pending_file_read_and_save_waits(self):
        self.load('permanent')
        self.page.wait_for_function("!document.getElementById('save-button').disabled")
        self.page.evaluate('''() => {
            const picker = document.querySelector('input[type=file]');
            Object.defineProperty(picker, 'files', {configurable: true, value: [{name:'slow.txt', size:3,
                arrayBuffer: () => new Promise(resolve => window.finishRead = resolve)}]});
            picker.dispatchEvent(new Event('change'));
        }''')
        self.page.locator('#save-button').click()
        self.page.locator('#page-message').filter(has_text='still loading').wait_for()
        self.assertEqual(self.posts, [])
        self.page.locator('#value').fill('typed\n\tcontent  ')
        self.page.evaluate("finishRead(new TextEncoder().encode('old').buffer)")
        self.page.locator('#save-button').click()
        self.page.locator('#page-message').filter(has_text='Value saved.').wait_for()
        self.assertEqual(self.posts[-1][1]['value'], 'typed\n\tcontent  ')

    def test_html_contents_and_filename_are_not_executed(self):
        self.dashboard()
        card = self.page.locator('#value-control-panel .control-card')
        text = '<script>window.attacked = true</script>\n<img src=x onerror="window.attacked=true">\r\n'
        self.upload(card, text.encode(), '<img src=x onerror=alert(1)>.txt')
        self.assertIsNone(self.page.evaluate('window.attacked'))
        self.assertEqual(card.locator('script,img').count(), 0)
        card.locator('.save-value').click()
        self.page.wait_for_function("document.querySelector('.save-value').textContent === 'Saved'")
        self.assertEqual(self.posts[-1][1]['value'], text)


if __name__ == '__main__':
    unittest.main(verbosity=2)
