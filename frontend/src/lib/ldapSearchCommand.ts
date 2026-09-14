/**
 * ldapsearch command-line parser.
 *
 * Pastes a documented `ldapsearch` invocation into the workbench search form:
 * bind/transport options are dropped in favour of the saved connection
 * (collected in `ignoredConnection`, values never echoed back), output /
 * session options are collected in `ignoredUnsupported`, and the search
 * semantics (-b/-s/-a/-z/-A plus positionals) map onto the form vocabulary.
 * Pure functions only — no Vue / DOM dependencies.
 */

export interface LdapSearchCommandSearch {
    baseDn: string;
    scope: 'base' | 'one' | 'sub';
    filter: string;
    attributes: string[];
    sizeLimit?: number;
    typesOnly: boolean;
    derefAliases?: 'never' | 'searching' | 'finding' | 'always';
}

export type LdapSearchCommandReason =
    | 'empty'
    | 'missingValue'
    | 'missingBaseDn'
    | 'unknownOption'
    | 'scope'
    | 'derefAliases'
    | 'sizeLimit'
    | 'filter'
    | 'filterFile';

interface LdapSearchCommandBase {
    /** Parsed fields; a fresh default-shaped object (no user input) when ok=false. */
    search: LdapSearchCommandSearch;
    ignoredConnection: string[];
    ignoredUnsupported: string[];
    notes: string[];
}

export interface LdapSearchCommandSuccess extends LdapSearchCommandBase {
    ok: true;
}

export interface LdapSearchCommandFailure extends LdapSearchCommandBase {
    ok: false;
    reason: LdapSearchCommandReason;
    flag?: string;
    value?: string;
}

export type LdapSearchCommandResult = LdapSearchCommandSuccess | LdapSearchCommandFailure;

const defaultSearch = (): LdapSearchCommandSearch => ({
    baseDn: '',
    scope: 'sub',
    filter: '',
    attributes: [],
    sizeLimit: undefined,
    typesOnly: false,
    derefAliases: undefined,
});

const failure = (
    reason: LdapSearchCommandReason,
    extra: { flag?: string; value?: string } = {},
): LdapSearchCommandFailure => ({
    ok: false,
    search: defaultSearch(),
    ignoredConnection: [],
    ignoredUnsupported: [],
    notes: [],
    reason,
    ...extra,
});

/** Shell-ish tokenizer: double quotes group, backslash-newline continuations are pre-joined. */
const tokenize = (command: string): string[] => {
    const joined = command.replace(/\\\r?\n/g, ' ');
    const tokens: string[] = [];
    let current = '';
    let quoted = false;
    for (let i = 0; i < joined.length; i++) {
        const char = joined[i];
        if (char === '"' && joined[i - 1] !== '\\') {
            quoted = !quoted;
            continue;
        }
        if (!quoted && /\s/.test(char)) {
            if (current) tokens.push(current);
            current = '';
            continue;
        }
        current += char;
    }
    if (current) tokens.push(current);
    return tokens;
};

/** Flags that carry a value and belong to the replaced bind/transport surface. */
const CONNECTION_VALUE_FLAGS = new Set(['-H', '-h', '-p', '-D', '-w', '-y', '-Y', '-U', '-R', '-O', '-X', '-K']);
/** Boolean switches on the replaced bind/transport surface. */
const CONNECTION_BOOLEAN_FLAGS = new Set(['-x', '-W', '-Q', '-I', '-N', '-C']);
/** Output/session flags that cannot influence the search semantics. */
const UNSUPPORTED_VALUE_FLAGS = new Set(['-o', '-l', '-E', '-S', '-T', '-F', '-e']);
const UNSUPPORTED_BOOLEAN_FLAGS = new Set(['-L', '-v', '-c', '-u', '-t']);

const SCOPES = ['base', 'one', 'sub', 'children'] as const;
const DEREF_ALIASES: Record<string, 'never' | 'searching' | 'finding' | 'always'> = {
    never: 'never',
    search: 'searching',
    find: 'finding',
    always: 'always',
};

type BooleanKind = 'connection' | 'unsupported';

const classifyBoolean = (letter: string): BooleanKind | null => {
    if (CONNECTION_BOOLEAN_FLAGS.has(`-${letter}`)) return 'connection';
    if (UNSUPPORTED_BOOLEAN_FLAGS.has(`-${letter}`)) return 'unsupported';
    return null;
};

/** RFC 4515 shape guard: parens balanced (raw escapes like `\28` are skipped). */
const isPlausibleFilter = (filter: string): boolean => {
    let depth = 0;
    for (let i = 0; i < filter.length; i++) {
        const char = filter[i];
        if (char === '\\') {
            i++;
            continue;
        }
        if (char === '(') depth++;
        if (char === ')') {
            depth--;
            if (depth < 0) return false;
        }
    }
    return depth === 0;
};

const pushFlag = (list: string[], flag: string) => {
    if (!list.includes(flag)) list.push(flag);
};

export const parseLdapSearchCommand = (command: string): LdapSearchCommandResult => {
    const tokens = tokenize(command || '');
    if (!tokens.length) return failure('empty');
    // A leading "$" shell prompt and the program name itself are presentation
    // artifacts; the spec treats the first non-option token as the program.
    if (tokens[0] === '$') tokens.shift();
    if (tokens.length && !tokens[0].startsWith('-')) tokens.shift();
    if (!tokens.length) return failure('empty');

    const search = defaultSearch();
    // Reported order: value-carrying flags first (encounter order), then the
    // boolean switches.
    const connectionValueFlags: string[] = [];
    const connectionBooleanFlags: string[] = [];
    const unsupportedValueFlags: string[] = [];
    const unsupportedBooleanFlags: string[] = [];
    const notes: string[] = [];
    const positionals: string[] = [];
    let scopeSource: (typeof SCOPES)[number] | undefined;

    const booleanList = (kind: BooleanKind) => (kind === 'connection' ? connectionBooleanFlags : unsupportedBooleanFlags);

    for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i];
        if (token === '--') {
            positionals.push(...tokens.slice(i + 1));
            break;
        }
        if (!token.startsWith('-')) {
            positionals.push(token);
            continue;
        }
        if (token === '-f') return failure('filterFile', { flag: '-f' });

        const cluster = token.length > 2 && !token.startsWith('--');
        const flag = cluster ? token.slice(0, 2) : token;
        const clusterValue = cluster ? token.slice(2) : undefined;
        // getopt-style value read: "-bvalue" clusters or the next token;
        // a value-taking option without one is a hard failure.
        const readValue = (): { value?: string; failure?: LdapSearchCommandFailure } => {
            if (clusterValue !== undefined) return { value: clusterValue };
            const next = tokens[i + 1];
            if (next === undefined) return { failure: failure('missingValue', { flag }) };
            i++;
            return { value: next };
        };

        if (flag === '-A') {
            search.typesOnly = true;
            continue;
        }
        if (flag === '-b' || flag === '-s' || flag === '-a' || flag === '-z') {
            const { value, failure: readFailure } = readValue();
            if (readFailure) return readFailure;
            if (flag === '-b') {
                search.baseDn = value!;
            } else if (flag === '-s') {
                if (!(SCOPES as readonly string[]).includes(value!)) return failure('scope', { value });
                scopeSource = value as (typeof SCOPES)[number];
            } else if (flag === '-a') {
                const mapped = DEREF_ALIASES[value!];
                if (!mapped) return failure('derefAliases', { value });
                search.derefAliases = mapped;
            } else {
                const parsed = Number(value);
                if (!Number.isInteger(parsed)) return failure('sizeLimit', { value });
                search.sizeLimit = parsed;
            }
            continue;
        }

        const booleanKind: BooleanKind | null = CONNECTION_BOOLEAN_FLAGS.has(flag)
            ? 'connection'
            : UNSUPPORTED_BOOLEAN_FLAGS.has(flag)
                ? 'unsupported'
                : null;
        if (booleanKind) {
            const letters = [...token.slice(1)];
            const kinds = letters.map(classifyBoolean);
            if (kinds.some((kind) => kind === null)) return failure('unknownOption', { flag: token });
            const first = letters.join('');
            const uniform = kinds.every((kind) => kind === kinds[0]);
            if (uniform) {
                // A same-family switch cluster is reported verbatim ("-LLL");
                // a mixed cluster splits into single-letter flags ("-xLLL").
                pushFlag(booleanList(kinds[0]!), first.length > 1 ? token : `-${first}`);
            } else {
                for (const letter of letters) {
                    pushFlag(booleanList(classifyBoolean(letter)!), `-${letter}`);
                }
            }
            continue;
        }
        if (CONNECTION_VALUE_FLAGS.has(flag)) {
            const { failure: readFailure } = readValue();
            if (readFailure) return readFailure;
            pushFlag(connectionValueFlags, flag);
            continue;
        }
        if (UNSUPPORTED_VALUE_FLAGS.has(flag)) {
            const { failure: readFailure } = readValue();
            if (readFailure) return readFailure;
            pushFlag(unsupportedValueFlags, flag);
            continue;
        }
        return failure('unknownOption', { flag: token });
    }

    if (scopeSource !== undefined) {
        if (scopeSource === 'children') notes.push('scopeChildren');
        search.scope = scopeSource === 'children' ? 'sub' : scopeSource;
    }
    if (!search.baseDn) return failure('missingBaseDn');

    const [filter, ...attributes] = positionals;
    if (filter !== undefined) {
        if (!filter.startsWith('(') || !isPlausibleFilter(filter)) return failure('filter', { value: filter });
        search.filter = filter;
        search.attributes = attributes;
    } else {
        search.filter = '(objectClass=*)';
    }
    return {
        ok: true,
        search,
        ignoredConnection: [...connectionValueFlags, ...connectionBooleanFlags],
        ignoredUnsupported: [...unsupportedValueFlags, ...unsupportedBooleanFlags],
        notes,
    };
};
