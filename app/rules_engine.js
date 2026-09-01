const isPlainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));

const allowedConditionOperators = new Set([
    'eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'contains', 'starts_with', 'ends_with',
    'in', 'not_in', 'exists', 'empty', 'not_empty'
]);
const allowedExpressionOps = new Set(['add', 'subtract', 'multiply', 'divide', 'concat', 'coalesce']);

const normalizeCondition = node => {
    if (node && Array.isArray(node.and)) return {type: 'group', op: 'and', children: node.and.map(normalizeCondition)};
    if (node && Array.isArray(node.or)) return {type: 'group', op: 'or', children: node.or.map(normalizeCondition)};
    if (!node || typeof node !== 'object') throw new TypeError('Condition nodes must be objects.');
    if (node.type === 'group' || Array.isArray(node.children)) {
        const op = String(node.op || 'and').toLowerCase();
        if (!['and', 'or'].includes(op)) throw new TypeError('Condition group op must be "and" or "or".');
        return {type: 'group', op, children: (node.children || []).map(normalizeCondition)};
    }
    const field = String(node.field ?? '').trim();
    const aliases = {'=': 'eq', '==': 'eq', '!=': 'neq', '>': 'gt', '>=': 'gte', '<': 'lt', '<=': 'lte', startsWith: 'starts_with', endsWith: 'ends_with'};
    const operator = aliases[node.operator] || String(node.operator || 'eq');
    if (!field) throw new TypeError('Every condition requires a field.');
    if (!allowedConditionOperators.has(operator)) throw new TypeError(`Unsupported condition operator: ${operator}`);
    return {type: 'condition', field, operator, ...(['exists', 'empty', 'not_empty'].includes(operator) ? {} : {value: clone(node.value)})};
};

const normalizeExpression = expression => {
    if (expression === undefined) return {type: 'const', value: null};
    if (expression === null || typeof expression !== 'object' || Array.isArray(expression)) return {type: 'const', value: clone(expression)};
    if (!expression.type && Object.prototype.hasOwnProperty.call(expression, 'field')) return {type: 'field', path: String(expression.field).trim()};
    const type = String(expression.type || 'const');
    if (type === 'const') return {type, value: clone(expression.value)};
    if (type === 'field') {
        const path = String(expression.path ?? expression.field ?? '').trim();
        if (!path) throw new TypeError('Field expressions require path.');
        return {type, path};
    }
    if (type === 'op') {
        const op = String(expression.op || '').toLowerCase();
        if (!allowedExpressionOps.has(op)) throw new TypeError(`Unsupported expression operator: ${op}`);
        const args = Array.isArray(expression.args) ? expression.args.map(normalizeExpression) : [];
        if (!args.length) throw new TypeError(`${op} expression requires at least one argument.`);
        if (['subtract', 'divide'].includes(op) && args.length < 2) throw new TypeError(`${op} expression requires at least two arguments.`);
        return {type, op, args};
    }
    if (type === 'conditional') {
        return {
            type,
            when: normalizeCondition(expression.when ?? {type: 'group', op: 'and', children: []}),
            then: normalizeExpression(expression.then),
            else: normalizeExpression(expression.else)
        };
    }
    throw new TypeError(`Unsupported expression type: ${type}`);
};

const normalizeAction = action => {
    if (!action || typeof action !== 'object') throw new TypeError('Actions must be objects.');
    const type = String(action.type || 'set').toLowerCase();
    const field = String(action.field ?? '').trim();
    if (!field) throw new TypeError('Every action requires a field.');
    if (type === 'unset') return {type, field};
    if (type !== 'set') throw new TypeError(`Unsupported action type: ${type}`);
    return {type, field, value: normalizeExpression(action.value)};
};

const resultToActions = result => Object.entries(result || {}).map(([field, value]) => ({type: 'set', field, value: {type: 'const', value: clone(value)}}));

const normalizeRules = rules => {
    if (!Array.isArray(rules)) throw new TypeError('rules must be an array.');
    return rules.map((rule, index) => {
        if (!rule || typeof rule !== 'object') throw new TypeError(`Rule ${index + 1} must be an object.`);
        let actions;
        if (Array.isArray(rule.actions)) actions = rule.actions.map(normalizeAction);
        else {
            const result = rule.result ?? rule.output ?? {};
            if (!isPlainObject(result)) throw new TypeError(`Rule ${index + 1} result must be a JSON object.`);
            actions = resultToActions(result);
        }
        const afterMatch = String(rule.afterMatch ?? rule.after_match ?? (rule.continue === true ? 'continue' : 'stop')).toLowerCase();
        if (!['continue', 'stop'].includes(afterMatch)) throw new TypeError(`Rule ${index + 1} afterMatch must be "continue" or "stop".`);
        return {
            name: String(rule.name ?? ''),
            when: normalizeCondition(rule.when ?? rule.conditions ?? {type: 'group', op: 'and', children: []}),
            actions,
            afterMatch
        };
    });
};

const getPath = (obj, path) => {
    if (obj != null && Object.prototype.hasOwnProperty.call(obj, path)) return obj[path];
    return String(path).split('.').reduce((value, key) => value == null ? undefined : value[key], obj);
};

const ensureContainer = (parent, key, nextKey) => {
    if (parent[key] != null && typeof parent[key] === 'object') return parent[key];
    parent[key] = /^\d+$/.test(nextKey) ? [] : {};
    return parent[key];
};

const setPath = (obj, path, value) => {
    const parts = String(path).split('.');
    let current = obj;
    for (let i = 0; i < parts.length - 1; i++) {
        const key = parts[i];
        if (Array.isArray(current)) {
            const index = Number(key);
            if (!Number.isInteger(index) || index < 0) throw new TypeError(`Invalid array index in path: ${path}`);
            while (current.length <= index) current.push(null);
            if (current[index] == null || typeof current[index] !== 'object') current[index] = /^\d+$/.test(parts[i + 1]) ? [] : {};
            current = current[index];
        } else current = ensureContainer(current, key, parts[i + 1]);
    }
    const last = parts[parts.length - 1];
    if (Array.isArray(current)) {
        const index = Number(last);
        if (!Number.isInteger(index) || index < 0) throw new TypeError(`Invalid array index in path: ${path}`);
        while (current.length <= index) current.push(null);
        current[index] = value;
    } else current[last] = value;
};

const unsetPath = (obj, path) => {
    const parts = String(path).split('.');
    const last = parts.pop();
    const parent = parts.length ? getPath(obj, parts.join('.')) : obj;
    if (parent == null) return;
    if (Array.isArray(parent) && /^\d+$/.test(last)) parent.splice(Number(last), 1);
    else if (typeof parent === 'object') delete parent[last];
};

const asBoolean = value => {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return value !== 0;
    if (typeof value === 'string') {
        const lowered = value.trim().toLowerCase();
        if (['true', '1', 'yes', 'y'].includes(lowered)) return true;
        if (['false', '0', 'no', 'n', ''].includes(lowered)) return false;
    }
    return Boolean(value);
};
const equalValue = (actual, expected) => {
    if (expected === null) return actual == null;
    if (typeof expected === 'number') {
        if (actual === '' || actual == null) return false;
        const numeric = Number(actual);
        return Number.isFinite(numeric) && numeric === expected;
    }
    if (typeof expected === 'boolean') return asBoolean(actual) === expected;
    if (typeof expected === 'object') {
        try { return JSON.stringify(actual) === JSON.stringify(expected); } catch { return false; }
    }
    return String(actual ?? '') === String(expected ?? '');
};
const compareValue = (actual, expected) => {
    const a = Number(actual), b = Number(expected);
    if (actual !== '' && expected !== '' && Number.isFinite(a) && Number.isFinite(b)) return a === b ? 0 : (a > b ? 1 : -1);
    return String(actual ?? '').localeCompare(String(expected ?? ''));
};
const isEmpty = value => value == null || value === '' || (Array.isArray(value) && value.length === 0) || (isPlainObject(value) && Object.keys(value).length === 0);

const evaluateCondition = (condition, input) => {
    const actual = getPath(input, condition.field), expected = condition.value;
    switch (condition.operator) {
        case 'eq': return equalValue(actual, expected);
        case 'neq': return !equalValue(actual, expected);
        case 'gt': return compareValue(actual, expected) > 0;
        case 'gte': return compareValue(actual, expected) >= 0;
        case 'lt': return compareValue(actual, expected) < 0;
        case 'lte': return compareValue(actual, expected) <= 0;
        case 'contains': return Array.isArray(actual) ? actual.some(value => equalValue(value, expected)) : String(actual ?? '').includes(String(expected ?? ''));
        case 'starts_with': return String(actual ?? '').startsWith(String(expected ?? ''));
        case 'ends_with': return String(actual ?? '').endsWith(String(expected ?? ''));
        case 'in': {
            const list = Array.isArray(expected) ? expected : String(expected ?? '').split(',').map(value => value.trim());
            return list.some(value => equalValue(actual, value));
        }
        case 'not_in': {
            const list = Array.isArray(expected) ? expected : String(expected ?? '').split(',').map(value => value.trim());
            return !list.some(value => equalValue(actual, value));
        }
        case 'exists': return actual !== undefined && actual !== null;
        case 'empty': return isEmpty(actual);
        case 'not_empty': return !isEmpty(actual);
        default: return false;
    }
};

const evaluateConditionNode = (node, input) => {
    if (node.type === 'condition') return evaluateCondition(node, input);
    const children = node.children || [];
    return node.op === 'or' ? children.some(child => evaluateConditionNode(child, input)) : children.every(child => evaluateConditionNode(child, input));
};

const numeric = value => {
    const number = Number(value);
    if (!Number.isFinite(number)) throw new TypeError(`Expected numeric value, got ${JSON.stringify(value)}`);
    return number;
};

const evaluateExpression = (expression, input) => {
    if (expression.type === 'const') return clone(expression.value);
    if (expression.type === 'field') return clone(getPath(input, expression.path));
    if (expression.type === 'conditional') return evaluateExpression(evaluateConditionNode(expression.when, input) ? expression.then : expression.else, input);
    const values = expression.args.map(arg => evaluateExpression(arg, input));
    switch (expression.op) {
        case 'add': return values.reduce((sum, value) => sum + numeric(value), 0);
        case 'subtract': return values.slice(1).reduce((result, value) => result - numeric(value), numeric(values[0]));
        case 'multiply': return values.reduce((result, value) => result * numeric(value), 1);
        case 'divide': return values.slice(1).reduce((result, value) => {
            const divisor = numeric(value);
            if (divisor === 0) throw new TypeError('Division by zero.');
            return result / divisor;
        }, numeric(values[0]));
        case 'concat': return values.map(value => value == null ? '' : String(value)).join('');
        case 'coalesce': return values.find(value => value !== null && value !== undefined);
        default: throw new TypeError(`Unsupported expression operator: ${expression.op}`);
    }
};

const executeActions = (actions, working, changes, unsetFields) => {
    actions.forEach(action => {
        if (action.type === 'unset') {
            unsetPath(working, action.field);
            unsetFields.push(action.field);
            unsetPath(changes, action.field);
            return;
        }
        const value = evaluateExpression(action.value, working);
        setPath(working, action.field, clone(value));
        setPath(changes, action.field, clone(value));
    });
};

const evaluateRules = (rules, input) => {
    const normalized = normalizeRules(rules);
    const working = clone(input || {});
    const changes = {};
    const unsetFields = [];
    const matchedRules = [];
    normalized.forEach((rule, index) => {
        if (matchedRules.stopped) return;
        if (!evaluateConditionNode(rule.when, working)) return;
        matchedRules.push({index, name: rule.name, afterMatch: rule.afterMatch});
        executeActions(rule.actions, working, changes, unsetFields);
        if (rule.afterMatch === 'stop') matchedRules.stopped = true;
    });
    delete matchedRules.stopped;
    return {
        matched: matchedRules.length > 0,
        matchedRules,
        ruleIndex: matchedRules.length ? matchedRules[0].index : -1,
        ruleName: matchedRules.length ? matchedRules[0].name : '',
        result: changes,
        unsetFields,
        output: working
    };
};

module.exports = {
    isPlainObject,
    clone,
    normalizeCondition,
    normalizeExpression,
    normalizeAction,
    normalizeRules,
    getPath,
    setPath,
    unsetPath,
    evaluateConditionNode,
    evaluateExpression,
    evaluateRules
};
