const assert = require('node:assert/strict');
const {test, before, after} = require('node:test');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {execFile, execFileSync} = require('node:child_process');
const {promisify} = require('node:util');
const run = promisify(execFile);
const BotControl = require('..');
const {MapperDefinition} = BotControl;
const engine = require('../app/rules_engine');
const {fixtures, set} = require('./fixtures.cjs');
const root = path.resolve(__dirname, '..');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'simple-toggle-clients-'));
const requests = [];
let baseUrl, revision = 1;
const definition = () => ({key: 'orders /שלום', token: 'mapper /שלום', title: 'Orders', description: 'test', revision: String(revision), example: {amount: 2}, rules: [{name: 'set', actions: [set('approved', true)]}]});
const values = [
    {key: 'false', value: false, token: 'false', botName: 'a'},
    {key: 'zero', value: 0, token: 'zero', botName: 'a'},
    {key: 'empty', value: '', token: 'empty', botName: 'a'},
    {key: 'null', value: null, token: 'null', botName: 'a'},
    {key: 'duplicate', value: 'new', token: 'value /שלום', botName: 'a'},
    {key: 'duplicate', value: 'old', token: 'old', bot_name: 'b'}
];
const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const route = decodeURIComponent(url.pathname.replace(/^\/api/, ''));
    let text = '';
    for await (const chunk of req) text += chunk;
    const body = text ? JSON.parse(text) : null;
    requests.push({method: req.method, path: route, query: url.search, auth: req.headers.authorization || null, etag: req.headers['if-none-match'] || null, body});
    const send = (data, status = 200) => { res.writeHead(status, {'Content-Type': 'application/json'}); res.end(JSON.stringify(data)); };
    if (route.startsWith('/error')) return send({error: 'unavailable'}, 503);
    if ((route.startsWith('/bot') || route.startsWith('/m/key/')) && req.headers.authorization !== 'Bearer admin') return send({error: 'unauthorized'}, 401);
    if (route === '/bot/values') return send(values);
    if (route === '/bots') return send([{botName: 'a', status: true}]);
    if (route === '/bot/mappers' && req.method === 'GET') return send([definition()]);
    if (route === '/bot/mappers' && req.method === 'POST') return send(body, 201);
    if (route.startsWith('/bot/mappers/')) return send(req.method === 'DELETE' ? {status: 'success'} : body);
    if (route === '/bot/generate_link') return send({token: 'generated', access_token: 'generated', url: 'https://example.test/prefix', set_value_path: 'v/generated', get_value_path: 'v/generated', user_path: 'bot_value_set.html?valueToken=generated'});
    if (route.startsWith('/bot/temp_link/')) return send({code: 'short', url: 'https://example.test/t/short', expires_at: null, one_time: true});
    if (route.startsWith('/bot/delete_value/')) return send({success: 'Value deleted successfully.'});
    if (route.startsWith('/bot/')) return send(req.method === 'GET' ? {botName: route.slice(5), status: true} : req.method === 'DELETE' ? {status: 'success'} : {status: body.status});
    if (route.startsWith('/v/')) {
        if (route === '/v/missing') return send({error: 'Invalid value access token.'}, 404);
        if (req.method === 'POST') return send({status: 'success'});
        return send({value: route === '/v/blank' ? '  ' : 'direct'});
    }
    if (route.startsWith('/m/')) {
        if (route.endsWith('/missing')) return send({error: 'Condition mapper not found.'}, 404);
        if (route.endsWith('/invalid')) return send([]);
        if (req.method === 'GET') {
            const etag = `"rev-${revision}"`;
            res.setHeader('ETag', etag);
            if (req.headers['if-none-match'] === etag) { res.writeHead(304); return res.end(); }
            return send(definition());
        }
        const result = engine.evaluateRules(definition().rules, body);
        return send(url.searchParams.get('meta') === 'true' ? result : url.searchParams.get('merge') === 'true' ? result.output : result.result);
    }
    send({error: 'Unexpected route'}, 404);
});

before(async () => {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}/api`;
});
after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(temporary, {recursive: true, force: true});
});

test('CommonJS, ESM, and package-root exports keep working', async () => {
    assert.equal(require('bots-status-manager'), BotControl);
    const esm = await import('bots-status-manager');
    assert.equal(esm.default, BotControl);
    assert.equal(esm.BotControl, BotControl);
    assert.equal(esm.MapperDefinition, MapperDefinition);
    assert.equal(engine, require('../client/js/rules-engine.cjs'));
});

for (const fixture of fixtures) test(`local mapper: ${fixture.name}`, () => {
    const mapper = new MapperDefinition({rules: fixture.rules});
    const input = structuredClone(fixture.input);
    const result = mapper.evaluateDetailed(input);
    assert.deepEqual(result.output, fixture.expected);
    assert.deepEqual(input, fixture.input);
    assert.deepEqual(result.changes, result.result);
    assert.deepEqual(mapper.evaluate(input), fixture.expected);
    mapper.getRules().length = 0;
    assert.equal(mapper.apply(input), input);
    assert.deepEqual(input, fixture.expected);
});

test('apply preserves nested references; evaluate isolates nested constants', () => {
    const mapper = new MapperDefinition({rules: [{actions: [set('nested.x', 1), set('constant', {x: [1]})]}]});
    const nested = {}, input = {nested};
    mapper.apply(input);
    assert.equal(input.nested, nested);
    assert.equal(nested.x, 1);
    input.constant.x.push(2);
    assert.deepEqual(mapper.evaluate({}).constant, {x: [1]});
    assert.throws(() => mapper.apply(null), /JSON object/);
    assert.throws(() => mapper.evaluate([]), /JSON object/);
    assert.throws(() => new MapperDefinition([]), /JSON object/);
    const divide = new MapperDefinition({rules: [{actions: [{type: 'set', field: 'x', value: {type: 'op', op: 'divide', args: [1, 0]}}]}]});
    assert.throws(() => divide.evaluate({}), /Division by zero/);
});

async function jsHttpReport() {
    BotControl.configure(baseUrl + '///', 'admin');
    const c = BotControl, r = {};
    r.values = await c.getValues(); r.valuesMap = await c.getValuesMap(); r.byBot = await c.getValuesByBot('a'); r.found = await c.findValue('duplicate', 'b');
    for (const key of ['false', 'zero', 'empty', 'null', 'missing']) r[key] = await c.getValueByKey(key, 'fallback');
    r.value = await c.getValue('value /שלום'); r.only = await c.getValueOnlyValue('value /שלום', 'fallback'); r.onlyMissing = await c.getValueOnlyValue('missing', 'fallback'); r.nonEmpty = await c.getValueOnlyValueNoEmptyOrNull('blank', 'fallback');
    r.set = await c.setValue('value /שלום', 'שלום\n"quoted"\\ 😀'); r.setKey = await c.setValueByKey('duplicate', 0, 'b'); r.missingSet = await c.setValueByKey('missing', true);
    r.deleteValue = await c.deleteValue('value /שלום'); r.permanent = c.getPermanentValueUrl('value /שלום', true);
    r.temporary = await c.createTemporarySetUrl('value /שלום', 0); r.temporaryDefault = await c.createTemporarySetUrl('value /שלום'); r.temporaryKey = await c.createTemporarySetUrlByKey('duplicate', 'b', 15); r.missingTemporary = await c.createTemporarySetUrlByKey('missing');
    r.mappers = await c.getMappers(); r.findMapper = await c.findMapper('orders /שלום'); r.createMapper = await c.createMapper({key: 'new', rules: []}); r.updateMapper = await c.updateMapper('mapper /שלום', {title: 'updated'}); r.deleteMapper = await c.deleteMapper('mapper /שלום');
    const row = {amount: 2};
    r.map = await c.map('mapper /שלום', row); r.mapRequest = await c.mapRequest('mapper /שלום', row); r.applyMap = await c.applyMap('mapper /שלום', row); r.mapMeta = await c.map('mapper /שלום', row, {meta: true}); r.mapByKey = await c.mapByKey('orders /שלום', row); r.applyByKey = await c.applyMapByKey('orders /שלום', row); r.mapperUrl = c.getMapperUrl('mapper /שלום', {merge: true, meta: true});
    r.bots = await c.getBots();
    const bot = new c('bot /שלום');
    r.status = await bot.getStatus(); r.enable = await bot.enable(); r.disable = await bot.disable(); r.setStatus = await bot.setStatus(true, {title: 'title'}); r.remove = await bot.remove(); r.generated = await bot.generateUrl('key', 'description', false); r.generatedTemporary = await bot.generateTemporaryUrl('key', 'description', 0, 15); r.generatedAlias = await bot.generateTempUrl('key');
    const mapper = await c.getMapper('orders /שלום');
    assert.equal(await c.getMapper('orders /שלום'), mapper);
    assert.equal(await c.refreshMapper('orders /שלום'), mapper);
    const count = requests.length;
    r.local = mapper.evaluate(row);
    for (let i = 0; i < 100; i++) mapper.evaluate(row);
    assert.equal(requests.length, count);
    class Anonymous extends c {}
    Anonymous.configure(baseUrl);
    r.anonymousMapper = (await Anonymous.getMapperByToken('mapper /שלום')).evaluate(row); r.anonymousValue = await Anonymous.getValue('value /שלום');
    c.invalidate('orders /שלום'); assert.notEqual(await c.getMapper('orders /שלום'), mapper);
    c.clearCache(); assert.notEqual(await c.getMapper('orders /שלום'), mapper);
    await assert.rejects(Anonymous.getValues(), /admin token/);
    class Broken extends c {}
    Broken.configure(baseUrl + '/error', 'admin');
    await assert.rejects(Broken.getValues(), {http_code: 503});
    await assert.rejects(c.getMapper('missing'), {http_code: 404});
    await assert.rejects(c.getMapperByToken('invalid'), /JSON object/);
    assert.equal(await Broken.getValueOnlyValue('x', 'fallback'), 'fallback');
    return r;
}

test('Java 8 API compilation, cross-language rules, direct values, and HTTP feature parity', async () => {
    const version = await run('javac', ['-version']);
    const flags = /javac 1\.8/.test(version.stdout + version.stderr) ? ['-source', '8', '-target', '8'] : ['--release', '8'];
    await run('javac', [...flags, '-encoding', 'UTF-8', '-d', temporary, path.join(root, 'client/java/SimpleToggleMapper.java'), path.join(__dirname, 'java/ClientParityTest.java')]);
    assert.equal(fs.readFileSync(path.join(temporary, 'SimpleToggleMapper.class')).readUInt16BE(6), 52);
    const fixtureFile = path.join(temporary, 'fixtures.json');
    fs.writeFileSync(fixtureFile, JSON.stringify(fixtures));
    const begin = requests.length;
    const expected = await jsHttpReport();
    const jsRequests = requests.slice(begin);
    const middle = requests.length;
    const java = await run('java', ['-cp', temporary, 'ClientParityTest', baseUrl, fixtureFile], {timeout: 30000});
    const actual = JSON.parse(java.stdout);
    assert.deepEqual(actual.http, expected);
    assert.deepEqual(requests.slice(middle), jsRequests, 'Java and JS must send the same methods, paths, bodies, auth and conditional headers');
    actual.fixtures.forEach((result, index) => {
        const fixture = fixtures[index], js = new MapperDefinition({rules: fixture.rules}).evaluateDetailed(fixture.input);
        assert.deepEqual(result, {output: js.output, changes: js.changes, unsetFields: js.unsetFields, matchedRules: js.matchedRules, matched: js.matched}, fixture.name);
    });
    assert.equal(actual.fixtures.length, fixtures.length);
    assert.equal(expected.false, false); assert.equal(expected.zero, 0); assert.equal(expected.empty, ''); assert.equal(expected.null, 'fallback'); assert.equal(expected.valuesMap.duplicate, 'new');
    assert(jsRequests.some(r => r.etag === '"rev-1"'));
    assert(jsRequests.filter(r => r.path.startsWith('/v/') || (r.path.startsWith('/m/') && !r.path.startsWith('/m/key/'))).every(r => r.auth === null));
});

test('single-flight definition cache, conditional refresh, and reconfiguration', async () => {
    BotControl.configure(baseUrl, 'admin');
    let begin = requests.length;
    const definitions = await Promise.all(Array.from({length: 10}, () => BotControl.getMapper('orders /שלום')));
    assert(definitions.every(item => item === definitions[0]));
    assert.equal(requests.length - begin, 1);
    assert.equal(await BotControl.refreshMapper('orders /שלום'), definitions[0]);
    revision++;
    const fresh = await BotControl.refreshMapper('orders /שלום');
    assert.notEqual(fresh, definitions[0]); assert.equal(fresh.getRevision(), '2');
    await assert.rejects(BotControl.getMapper('missing'), {http_code: 404});
    await assert.rejects(BotControl.getMapper('missing'), {http_code: 404});
    assert.equal(BotControl.mapperRequests.size, 0);
    BotControl.configure(baseUrl, 'wrong');
    await assert.rejects(BotControl.getMapper('orders /שלום'), {http_code: 401});
    BotControl.configure(baseUrl);
    await assert.rejects(BotControl.getMapper('orders /שלום'), /admin token/);
    assert.equal((await BotControl.getMapperByToken('mapper /שלום')).getKey(), 'orders /שלום');
});

test('invalidated or reconfigured in-flight fetches cannot refill the cache', async () => {
    const originalFetch = global.fetch;
    try {
        for (const invalidate of [() => BotControl.invalidate('orders'), () => BotControl.clearCache(), () => BotControl.configure(baseUrl, 'new-token')]) {
            BotControl.configure(baseUrl, 'admin');
            let resolve;
            global.fetch = () => new Promise(done => { resolve = done; });
            const pending = BotControl.getMapper('orders');
            invalidate();
            resolve(new Response(JSON.stringify(definition()), {status: 200}));
            await pending;
            assert.equal(BotControl.mapperCache.size, 0);
        }
    } finally { global.fetch = originalFetch; }
});

test('npm package ships the complete JS client, not Java or server sources', () => {
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const packed = JSON.parse(execFileSync(npm, ['pack', '--dry-run', '--json', '--ignore-scripts', '--cache', path.join(temporary, 'npm-cache')], {cwd: root, encoding: 'utf8'}))[0];
    const files = packed.files.map(file => file.path);
    for (const name of ['index.cjs', 'index.mjs', 'index.d.ts', 'index.d.mts', 'mapper.cjs', 'rules-engine.cjs']) assert(files.includes(`client/js/${name}`));
    assert(files.every(file => !file.startsWith('client/java/') && !file.startsWith('app/') && !file.startsWith('test/')));
    const pkg = require('../package.json');
    for (const entry of [pkg.main, pkg.module, pkg.types, ...Object.values(pkg.exports['.']).flatMap(Object.values)]) assert(files.includes(entry.replace(/^\.\//, '')));
});
