const {clone, isPlainObject, normalizeRules, evaluateRules} = require('./rules-engine.cjs');

class MapperDefinition {
    #definition;
    #etag;

    constructor(definition, etag = null) {
        if (!isPlainObject(definition)) throw new TypeError('Mapper definition must be a JSON object');
        this.#definition = {...clone(definition), rules: normalizeRules(definition.rules || [])};
        this.#etag = etag;
    }
    getKey() { return String(this.#definition.key ?? ''); }
    getTitle() { return String(this.#definition.title ?? ''); }
    getDescription() { return String(this.#definition.description ?? ''); }
    getToken() { return String(this.#definition.token ?? ''); }
    getRevision() { return String(this.#definition.revision ?? ''); }
    getEtag() { return this.#etag; }
    getExample() { return clone(this.#definition.example || {}); }
    getRules() { return clone(this.#definition.rules); }

    /** Returns a transformed deep copy, without HTTP or input mutation. */
    evaluate(input = {}) { return this.evaluateDetailed(input).output; }

    /** Mutates and returns the original object, including nested objects/arrays. */
    apply(target) {
        if (!isPlainObject(target)) throw new TypeError('target must be a JSON object');
        evaluateRules(this.#definition.rules, target, {mutate: true});
        return target;
    }

    evaluateDetailed(input = {}) {
        if (input != null && !isPlainObject(input)) throw new TypeError('input must be a JSON object');
        const result = evaluateRules(this.#definition.rules, input);
        return {...result, changes: result.result};
    }
}

module.exports = {MapperDefinition};
