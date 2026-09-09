export interface BotControlConfig {
    url: string;
    /** Optional when using permanent value/mapper tokens only. */
    token?: string;
}

export interface ApiResult {
    http_code: number;
    ok: boolean;
    [key: string]: any;
}

export interface ValueControl {
    key: string;
    value: any;
    description?: string;
    status?: boolean;
    token: string;
    accessToken?: string;
    botName?: string;
    bot_name?: string;
    updatedAt?: string;
    createdAt?: string;
}

export interface BotStatus {
    botName: string;
    title?: string;
    description?: string;
    status: boolean;
}

export interface TemporarySetLink extends ApiResult {
    code?: string;
    url?: string;
    expires_at?: string | null;
    one_time?: boolean;
}

export type MapperOperator = 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'contains' | 'starts_with' | 'ends_with' | 'in' | 'not_in' | 'exists' | 'empty' | 'not_empty';

export interface MapperCondition {
    type: 'condition';
    field: string;
    operator: MapperOperator;
    value?: any;
}

export interface MapperGroup {
    type: 'group';
    op: 'and' | 'or';
    children: Array<MapperGroup | MapperCondition>;
}

export interface MapperConstExpression {
    type: 'const';
    value: any;
}

export interface MapperFieldExpression {
    type: 'field';
    path: string;
}

export type MapperExpressionOperator = 'add' | 'subtract' | 'multiply' | 'divide' | 'concat' | 'coalesce';

export interface MapperOperationExpression {
    type: 'op';
    op: MapperExpressionOperator;
    args: MapperExpression[];
}

export interface MapperConditionalExpression {
    type: 'conditional';
    when: MapperGroup | MapperCondition;
    then: MapperExpression;
    else: MapperExpression;
}

export type MapperExpression = MapperConstExpression | MapperFieldExpression | MapperOperationExpression | MapperConditionalExpression;

export interface MapperSetAction {
    type: 'set';
    field: string;
    value: MapperExpression;
}

export interface MapperUnsetAction {
    type: 'unset';
    field: string;
}

export type MapperAction = MapperSetAction | MapperUnsetAction;

export interface MapperRule {
    name?: string;
    enabled?: boolean;
    when?: MapperGroup | MapperCondition;
    actions?: MapperAction[];
    afterMatch?: 'continue' | 'stop';
    /** Legacy v1 representation; accepted and normalized into constant set actions. */
    result?: Record<string, any>;
}

export interface ConditionMapper {
    definitionVersion?: number;
    revision?: string;
    key: string;
    title?: string;
    description?: string;
    token: string;
    accessToken?: string;
    definitionUrl?: string;
    definitionKeyUrl?: string;
    runtimeUrl?: string;
    example: Record<string, any>;
    rules: MapperRule[];
    updatedAt?: string;
    createdAt?: string;
}

export interface MapperConfig {
    key: string;
    title?: string;
    description?: string;
    example?: Record<string, any>;
    rules?: MapperRule[];
}

export interface MapperOptions {
    merge?: boolean;
    meta?: boolean;
}

export interface MapperEvaluationResult {
    output: Record<string, any>;
    changes: Record<string, any>;
    /** Alias of changes, matching the server's detailed response. */
    result: Record<string, any>;
    unsetFields: string[];
    matched: boolean;
    matchedRules: Array<{index: number; name: string; afterMatch: 'continue' | 'stop'}>;
    ruleIndex: number;
    ruleName: string;
}

export class MapperDefinition {
    constructor(definition: Partial<ConditionMapper>, etag?: string | null);
    getKey(): string;
    getTitle(): string;
    getDescription(): string;
    getToken(): string;
    getRevision(): string;
    getEtag(): string | null;
    getExample(): Record<string, any>;
    getRules(): MapperRule[];
    /** Local execution; returns a deep copy without changing input. */
    evaluate(input?: Record<string, any> | null): Record<string, any>;
    /** Local execution; mutates and returns target, including nested objects/arrays. */
    apply<T extends Record<string, any>>(target: T): T;
    evaluateDetailed(input?: Record<string, any> | null): MapperEvaluationResult;
}

export default class BotControl {
    static url: string;
    static token: string;
    static DEFAULT_TEMP_LINK_MINUTES: number;
    static MapperDefinition: typeof MapperDefinition;

    constructor(botName: string);

    static configure(config: BotControlConfig): typeof BotControl;
    static configure(url: string, token?: string): typeof BotControl;
    static init(url: string, token?: string): typeof BotControl;
    static getAuthorizationHeader(): {Authorization: string};
    static getRequest(fullUrl: string): Promise<ApiResult>;
    static deleteRequest(fullUrl: string): Promise<ApiResult>;
    static postRequest(fullUrl: string, obj?: any): Promise<ApiResult>;

    static getValues(): Promise<ValueControl[]>;
    static getValuesMap(): Promise<Record<string, any>>;
    static getValuesByBot(botName: string): Promise<ValueControl[]>;
    static findValue(key: string, botName?: string | null): Promise<ValueControl | null>;
    static getValueByKey(key: string, defaultValue?: any, botName?: string | null): Promise<any>;
    static setValueByKey(key: string, value: any, botName?: string | null): Promise<ApiResult>;
    static getPermanentValueUrl(valueToken: string, onlyValue?: boolean): string;
    static createTemporarySetUrl(valueToken: string, expiresInMinutes?: number): Promise<TemporarySetLink>;
    static createTemporarySetUrlByKey(key: string, botName?: string | null, expiresInMinutes?: number): Promise<TemporarySetLink>;

    /** Cached definition for local execution; requires the admin token. */
    static getMapper(key: string): Promise<MapperDefinition>;
    /** Conditional HTTP revalidation; returns the cached instance on 304. */
    static refreshMapper(key: string): Promise<MapperDefinition>;
    /** Fetch using only the permanent mapper token as the credential. */
    static getMapperByToken(token: string): Promise<MapperDefinition>;
    static invalidate(key: string): void;
    static clearCache(): void;
    static getMappers(): Promise<ConditionMapper[]>;
    static findMapper(key: string): Promise<ConditionMapper | null>;
    static createMapper(config: MapperConfig): Promise<ApiResult>;
    static updateMapper(mapperToken: string, config: Partial<MapperConfig>): Promise<ApiResult>;
    static deleteMapper(mapperToken: string): Promise<ApiResult>;
    static getMapperUrl(mapperToken: string, options?: MapperOptions): string;
    /** Server-side execution is a debugging convenience; bulk processing should evaluate downloaded definitions locally. */
    static mapRequest(mapperToken: string, input: Record<string, any>, options?: MapperOptions): Promise<ApiResult>;
    static map(mapperToken: string, input: Record<string, any>, options?: MapperOptions): Promise<any>;
    static applyMap(mapperToken: string, input: Record<string, any>): Promise<Record<string, any>>;
    static mapByKey(key: string, input: Record<string, any>, options?: MapperOptions): Promise<any>;
    static applyMapByKey(key: string, input: Record<string, any>): Promise<Record<string, any>>;

    static getBots(): Promise<BotStatus[]>;

    generateUrl(key: string, description?: string, value?: any): Promise<ApiResult & {
        token?: string;
        access_token?: string;
        permanent_access_token?: string;
        set_value_url?: string | null;
        get_value_url?: string | null;
        user_url?: string | null;
    }>;
    generateTemporaryUrl(key: string, description?: string, value?: any, expiresInMinutes?: number): Promise<ApiResult & {
        permanent_access_token?: string;
        temporary_url?: string | null;
        temporary_code?: string | null;
        temporary_expires_at?: string | null;
        temporary_http_code?: number;
        temporary_ok?: boolean;
    }>;
    generateTempUrl(key: string, description?: string, value?: any, expiresInMinutes?: number): ReturnType<BotControl['generateTemporaryUrl']>;

    static setValue(token: string, value: any): Promise<ApiResult>;
    static getValue(token: string): Promise<ApiResult>;
    static getValueOnlyValue(token: string, defaultValue?: any): Promise<any>;
    static getValueOnlyValueNoEmptyOrNull(token: string, defaultValue?: any): Promise<any>;
    static deleteValue(token: string): Promise<ApiResult>;

    getStatus(): Promise<ApiResult>;
    setStatus(status: boolean, extra?: Record<string, any>): Promise<ApiResult>;
    enable(): Promise<ApiResult>;
    disable(): Promise<ApiResult>;
    remove(): Promise<ApiResult>;
}

export {BotControl};
