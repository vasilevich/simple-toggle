const set = (field, value) => ({type: 'set', field, value: {type: 'const', value}});
const condition = (field, operator, value) => ({type: 'condition', field, operator, value});
const group = (op, ...children) => ({type: 'group', op, children});
const fixtures = [];
const check = (name, input, when, matched) => fixtures.push({name, input, rules: [{when, actions: [set('matched', true)]}], expected: {...input, ...(matched ? {matched: true} : {})}});
for (const [operator, actual, expected, matched] of [
    ['eq', '12', 12, true], ['neq', 12, 13, true], ['gt', 12, 10, true], ['gte', 12, 12, true],
    ['lt', 10, 12, true], ['lte', 12, 12, true], ['contains', 'a needle b', 'needle', true],
    ['contains', ['a', 'b'], 'b', true], ['contains', ['needle-extra'], 'needle', false],
    ['starts_with', 'abc', 'ab', true], ['ends_with', 'abc', 'bc', true],
    ['in', 'b', ['a', 'b'], true], ['not_in', 'c', ['a', 'b'], true], ['in', 'b', 'a, b', true],
    ['exists', 0, null, true], ['empty', [], null, true], ['empty', {}, null, true],
    ['not_empty', ' ', null, true], ['eq', 'yes', true, true], ['eq', '', false, true],
    ['eq', null, null, true], ['eq', '', 0, false], ['eq', {a: 1}, {a: 1}, true],
    ['eq', [1, 2], [1, 2], true], ['eq', 'a', 'b', false]
]) check(`${operator}: ${JSON.stringify(actual)} / ${JSON.stringify(expected)}`, {x: actual}, condition('x', operator, expected), matched);
check('missing field exists', {}, condition('x', 'exists'), false);
check('missing field empty', {}, condition('x', 'empty'), true);
check('nested AND/OR', {x: 5, y: 'yes'}, group('and', condition('x', 'gt', 2), group('or', condition('y', 'eq', 'yes'), condition('x', 'lt', 0))), true);
check('empty AND', {}, group('and'), true);
check('empty OR', {}, group('or'), false);
check('array dot path', {items: [{sku: 'a'}]}, condition('items.0.sku', 'eq', 'a'), true);
check('literal dotted key wins', {'a.b': 'literal', a: {b: 'nested'}}, condition('a.b', 'eq', 'literal'), true);
for (const [op, args, result] of [
    ['add', [2, 3, 4], 9], ['subtract', [10, 2, 3], 5], ['multiply', [2, 3, 4], 24],
    ['divide', [24, 2, 3], 4], ['concat', ['count=', 5, null], 'count=5'],
    ['coalesce', [null, 0, 9], 0], ['coalesce', [null, false, 9], false], ['coalesce', [null, '', 9], '']
]) fixtures.push({name: `expression ${op} ${JSON.stringify(args)}`, input: {}, rules: [{actions: [{type: 'set', field: 'answer', value: {type: 'op', op, args: args.map(value => ({type: 'const', value}))}}]}], expected: {answer: result}});
fixtures.push({name: 'field, conditional, nested arithmetic, continue and stop', input: {price: 100, count: 3, customer: {vip: true}, items: [{sku: 'a'}, {sku: 'b'}]}, rules: [
    {name: 'disabled', enabled: false, actions: [set('bad', true)]},
    {name: 'discount', afterMatch: 'continue', actions: [
        {type: 'set', field: 'price', value: {type: 'op', op: 'subtract', args: [{type: 'field', path: 'price'}, {type: 'op', op: 'multiply', args: [{type: 'field', path: 'count'}, 20]}]}},
        {type: 'set', field: 'customer.label', value: {type: 'conditional', when: condition('customer.vip', 'eq', true), then: 'VIP', else: 'regular'}},
        {type: 'unset', field: 'items.0'}, {type: 'unset', field: 'count'}
    ]},
    {name: 'later reads changed values', when: condition('price', 'eq', 40), actions: [set('approved', true)], afterMatch: 'stop'},
    {name: 'never reached', actions: [set('bad', true)]}
], expected: {price: 40, customer: {vip: true, label: 'VIP'}, items: [{sku: 'b'}], approved: true}});
fixtures.push({name: 'legacy result and immutable constants', input: {original: true}, rules: [{result: {'nested.value': {list: [1, 2]}}}], expected: {original: true, nested: {value: {list: [1, 2]}}}});
fixtures.push({name: 'nested array creation and unset changes', input: {}, rules: [{actions: [set('items.1.amount', 7), set('temporary', true), {type: 'unset', field: 'temporary'}]}], expected: {items: [null, {amount: 7}]}});
module.exports = {fixtures, set, condition};
