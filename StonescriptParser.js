// StonescriptParser.js
// Pass 1 – parse(code)  → Block[]  (AST with warnings)
// Pass 2 – toHtml(blocks) → HTML string

const B = {
  CONDITION: 'condition', ELSE: 'else', ELSEIF: 'elseif',
  COMMENT: 'comment', CONTINUE: 'continuation', COMMAND: 'command',
  PRINT: 'print', KEYWORD: 'keyword', FUNC_DEF: 'func_def',
  FOR_LOOP: 'for_loop', ASSIGN: 'assign', CALL: 'call',
  EMPTY: 'empty', RAW: 'raw', ASCII: 'ascii',
};

const T = {
  CONTROL: 'control', COMMENT: 'comment', CONTINUE: 'continue-op',
  COMMAND: 'command', KEYWORD: 'keyword', PRINT: 'print',
  VARIABLE: 'variable', FUNCTION: 'function', OPERATOR: 'operator',
  NUMBER: 'number', STRING: 'string', IDENTIFIER: 'identifier',
  PAREN: 'paren', BRACKET: 'bracket', SPACE: 'space', UNKNOWN: 'unknown',
};

const W = {
  ORPHAN:       'orphan_indent',
  INCONSISTENT: 'inconsistent_indent',
  EMPTY_BLOCK:  'empty_block',
  EMPTY_EXPR:   'empty_expression',
  BAD_FOLLOW:   'invalid_follow',
  ARG_COUNT:    'wrong_arg_count',
  BAD_OPERATOR: 'invalid_operator',
  UNKNOWN_CMD:  'unknown_command',
  BAD_IMPORT:   'invalid_import',
  BAD_VAR:      'invalid_var_name',
  BAD_ACTIVATE: 'invalid_activate',
  SEALED_PROP:  'sealed_property',
  BAD_STATEMENT:'invalid_statement',
  BAD_EXPR:     'invalid_expression',
  BAD_CONTINUE: 'invalid_continuation', BAD_ASCII: 'invalid_ascii',
  BAD_ARG_TYPE:  'invalid_arg_type',  UNDECLARED_VAR: 'undeclared_variable',
};

const SCOPE_OPENERS = [B.CONDITION, B.ELSEIF, B.ELSE, B.FUNC_DEF, B.FOR_LOOP];
const TRIVIAL_TYPES = [B.EMPTY, B.CONTINUE, B.COMMENT];

// Characters never valid in a condition expression
const INVALID_EXPR_CHARS = /[;]/;

class StonescriptParser {
  constructor(api) {
    this.api        = api;
    this.byId       = {};
    this.commands   = [];
    this.multiCmds  = [];
    this.keywords   = [];       // lowercase keyword ids
    this.keywordSet = new Set();
    this.varRoots   = [];
    this.printPfx   = ['>o', '>h', ">'", '>c', '>f', '>(', '>'];
    this.operators  = [':?','>=','<=','!=','++','--','=','!','&','|','>','<','+','-','*','/','%'];
    this.enumValues = {};

    // Loaded from __validation__ meta entry
    this.sealedGroups            = new Set();
    this.reservedNames           = new Set();
    this.validAbilityIds         = new Set();
    this.continuationStartsWith  = new Set();
    this.keywordsNotInExpr       = new Set();
    this.nonAssignableRoots      = new Set();
    this.funcValidate            = {};
    this.argTypeRules            = {};
    this.argTypeCheckEnabled     = false;
    this.validConditionOps       = new Set(['=','!','&','|','>','<','>=','<=']);

    // Loaded from ?.validate
    this.condValidate = {};
    // Loaded from import.validate
    this.importValidate = {};
    // Loaded from var.validate
    this.varValidate = {};

    this._buildIndex();
  }

  _buildIndex() {
    const singleCmds = [];
    for (const e of this.api) {
      this.byId[e.id] = e;
      switch (e.type) {
        case 'command':
          e.id.includes(' ') ? this.multiCmds.push(e.id) : singleCmds.push(e.id.toLowerCase());
          break;
        case 'keyword':
          this.keywords.push(e.id.toLowerCase());
          this.keywordSet.add(e.id.toLowerCase());
          break;
        case 'var':
        case 'func': {
          const root = e.id.split('.')[0];
          if (root && !this.varRoots.includes(root)) this.varRoots.push(root);
          break;
        }
        case 'enum':
          this.enumValues[e.id] = e.values || [];
          break;
        case 'meta':
          if (e.id === '__validation__') {
            this.sealedGroups           = new Set(e.sealed_groups              || []);
            this.reservedNames          = new Set(e.reserved_var_names         || []);
            this.validAbilityIds        = new Set(e.valid_ability_ids          || []);
            this.continuationStartsWith = new Set(e.continuation_must_start_with || []);
            this.keywordsNotInExpr      = new Set(e.keywords_not_allowed_in_expr || []);
            this.nonAssignableRoots     = new Set(e.non_assignable_roots        || []);
          }
          break;
      }
    }
    this.commands = singleCmds;
    this.multiCmds.sort((a, b) => b.length - a.length);
    this.printPfx = ['>o', '>h', '>`', '>c', '>f', '>(', '>'];

    // Cache validate objects from JSON entries
    if (this.byId['?'])      this.condValidate   = this.byId['?'].validate   || {};
    if (this.byId['import']) this.importValidate = this.byId['import'].validate || {};
    if (this.byId['var'])    this.varValidate    = this.byId['var'].validate  || {};

    // Load activate validation from activate.arg_validation (data-driven)
    const av = (this.byId['activate'] && this.byId['activate'].arg_validation) || {};
    this.abilityFixed   = new Set((av.fixed_values      || []).map(v => v.toLowerCase()));
    this.abilityKnown   = new Set((av.known_ability_ids || []).map(v => v.toLowerCase()));
    this.abilityCharset = av.charset ? new RegExp(av.charset) : /^[a-zA-Z_][a-zA-Z0-9_]*$/;
    this.validAbilityIds = new Set([...this.abilityFixed, ...this.abilityKnown]);
    this.funcValidate    = (this.byId['func'] && this.byId['func'].validate) || {};
    // Load arg type rules from __validation__.arg_type_rules
    if (this.byId['__validation__']) {
      const m = this.byId['__validation__'];
      this.argTypeRules        = m.arg_type_rules        || {};
      this.argTypeCheckEnabled = m.arg_type_check_enabled || false;
    }
  }

  // ── PUBLIC API ────────────────────────────────────────────
  format(code) { return this.toHtml(this.parse(code)); }
  parse(code) {
    const lines  = this._splitLines(code);
    const flat   = lines.map(l => this._parseLine(l));
    const tree   = this._buildTree(flat);
    // Second pass: scope analysis — find declared vars, then validate usage
    this._scopeAnalysis(tree);
    return tree;
  }
  toHtml(blocks) { return blocks.map(b => this._blockToHtml(b)).join('\n'); }

  // ── SCOPE ANALYSIS (second pass) ──────────────────────────────

  _scopeAnalysis(blocks) {
    // Pass A: collect all declared variable names and import roots
    const declared    = new Set(); // user-declared: var x = ...
    const importRoots = new Set(); // import references: var x = import y → x.*  is valid
    (function collect(bs) {
      for (const b of bs) {
        if (b.type === 'keyword' && b.name === 'var' && b.value) {
          const nameMatch = b.value.trim().match(/^([a-zA-Z_][a-zA-Z0-9_]*)/);
          if (nameMatch) {
            const name    = nameMatch[1];
            const valPart = b.value.trim().slice(name.length).replace(/^\s*=\s*/, '');
            if (/^import\s/.test(valPart.trim())) importRoots.add(name);
            else declared.add(name);
          }
        }
        // func name and params are declared
        if (b.type === 'func_def' && b.value) {
          // Add the function name itself so calls like DBash() are recognized
          const nameM = b.value.match(/^([a-zA-Z_][a-zA-Z0-9_]*)/);
          if (nameM) declared.add(nameM[1]);
          // Add params
          const paramsM = b.value.match(/\(([^)]*)\)/);
          if (paramsM) paramsM[1].split(',').forEach(p => { const t = p.trim(); if (t) declared.add(t); });
        }
        // for loop variables
        if (b.type === 'for_loop' && b.value) {
          const m = b.value.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*=/);
          if (m) declared.add(m[1]);
        }
        collect(b.children);
      }
    })(blocks);

    // Pass B: walk all blocks and check identifier tokens in expressions
    const self = this;
    (function check(bs) {
      for (const b of bs) {
        // Re-tokenize expressions to find unknown identifiers
        // We do this by inspecting existing tokens of type T.IDENTIFIER
        // that are not native vars, not declared, and not import roots
        self._checkBlockIdentifiers(b, declared, importRoots);
        check(b.children);
      }
    })(blocks);
  }

  _checkBlockIdentifiers(block, declared, importRoots) {
    if (!block.tokens) return;

    // Contexts where an identifier is NOT a variable reference:
    // - Right-hand side of = in a comparison: ?foe=boss → 'boss' is a string value
    // - Import path: var x=import Utils/File → 'Utils' is a path segment
    // - Func definition name: func myFunc() → 'myFunc' is being defined
    // - Func param names (already added to declared in scope collection)
    // We skip tokens that follow an operator '=' or '!' in a condition context.

    // Build a set of positions to skip (RHS of comparisons)
    // After '=' or '!' skip ALL tokens until next logical operator (& |) or paren/bracket.
    // Covers multi-word RHS: ?loc=haunted rocky → both 'haunted' and 'rocky' skipped.
    const skipPositions = new Set();
    const COMPARISON_OPS = new Set(['=', '!', '<', '>', '<=', '>=']);
    const LOGICAL_OPS    = new Set(['&', '|']);
    for (let i = 0; i < block.tokens.length; i++) {
      const [t, v] = block.tokens[i];
      if (t === T.OPERATOR && COMPARISON_OPS.has(v)) {
        let j = i + 1;
        while (j < block.tokens.length) {
          const [tt, tv] = block.tokens[j];
          if (tt === T.SPACE) { j++; continue; }
          if (tt === T.OPERATOR && LOGICAL_OPS.has(tv)) break;
          if (tt === T.PAREN || tt === T.BRACKET) break;
          skipPositions.add(j); j++;
        }
      }
    }

    // func_def and for_loop: the identifier right after keyword is a definition name, not usage
    const isDefinition = block.type === B.FUNC_DEF || block.type === B.FOR_LOOP;

    // keyword 'import': the arg is a path, not a variable
    const isImport = block.type === B.KEYWORD && block.name === 'import';

    // keyword 'var': the name is being declared, value may reference other vars (checked separately)
    const isVar = block.type === B.KEYWORD && block.name === 'var';

    // Commands: their argument is a search_string, ability_id, etc. — not variable references
    // We skip all IDENTIFIER tokens in the arg portion (after the command token)
    const LITERAL_ARG_FOLLOWS = new Set(['search_string','ability_id','sound_id',
      'hud_opts','ingredient_expr','script_path','print_args','string']);
    const isLiteralArgCmd = block.type === B.COMMAND && block.def &&
      LITERAL_ARG_FOLLOWS.has(block.def.follows);

    // Print blocks: the argument is a formatted string, not a variable reference
    const isPrint = block.type === B.PRINT;

    // Condition with no comparison operator: ?a or ?loc.begin — bare boolean expression.
    // In this case, an IDENTIFIER directly after '?' (with no operator) could be a valid
    // user variable used as a boolean. We still warn, but only if there's no way it's valid.
    // We track whether we've seen a comparison operator in the condition.
    let condHasOperator = false;
    if (block.type === B.CONDITION || block.type === B.ELSEIF) {
      condHasOperator = block.tokens.some(([t,v]) =>
        t === T.OPERATOR && new Set(['=','!','<','>','<=','>=']).has(v));
    }

    // Track position of the command keyword token to know when we're in the arg portion
    let cmdArgStart = -1;
    if (isLiteralArgCmd) {
      for (let i = 0; i < block.tokens.length; i++) {
        if (block.tokens[i][0] === T.COMMAND) { cmdArgStart = i + 1; break; }
      }
    }

    for (let i = 0; i < block.tokens.length; i++) {
      const [type, value] = block.tokens[i];
      if (type !== T.IDENTIFIER) continue; // only check IDENTIFIER, not VARIABLE (natives are fine)
      if (skipPositions.has(i)) continue;  // RHS of comparison — skip
      if (isDefinition && i <= 2) continue; // func/for name token — skip
      if (isImport) continue;               // entire arg is a path
      if (isVar) continue;                  // var declaration tokens — skip entirely
      if (isPrint) continue;                // print args are strings
      if (isLiteralArgCmd && i >= cmdArgStart) continue; // command literal arg — skip
      // Bare boolean condition: ?a with no operator — still warn (might be truly undeclared)
      // but only after all other skips

      // Skip boolean literals
      if (value === 'true' || value === 'false') continue;
      // Skip numeric-like
      if (/^[^a-zA-Z_]/.test(value)) continue;
      // Skip keywords
      if (this.keywordSet.has(value.toLowerCase())) continue;
      // Skip known natives
      if (this.varRoots.includes(value.split('.')[0])) continue;
      if (this.byId[value]) continue;
      const def = this._lookupFuncOrVar(value);
      if (def) continue;
      // Skip import root properties (x.method where var x=import y)
      const root = value.split('.')[0];
      if (importRoots.has(root)) continue;
      // Skip declared user variables
      if (declared.has(root)) continue;

      // Unknown identifier — warning
      block.tokens[i] = [T.UNKNOWN, value];
      block.warnings.push(this._warnW(W.UNDECLARED_VAR,
        `'${value}' no esta declarado. Declara la variable con 'var ${value}' antes de usarla.`));
    }
  }

  // ── ASCII BLOCK HELPERS ──────────────────────────────────────

  _isAsciiBlock(content) {
    const firstLine = content.split('\n')[0];
    return /\bascii\s*$/.test(firstLine.split('//')[0]) && content.includes('\nasciiend');
  }

  _parseAsciiBlock(indent, content) {
    const lines    = content.split('\n');
    const firstLine = lines[0];
    const artLines  = lines.slice(1, -1);
    const warns     = [];

    const asciiDef      = this.byId['ascii'];
    const validAfterIds = (asciiDef && asciiDef.validate && asciiDef.validate.valid_after_ids) || [];
    const isVarValue    = /^\s*var\s+/.test(firstLine);
    const isPrintArg    = validAfterIds.some(id => firstLine.includes(id));

    if (!isVarValue && !isPrintArg) {
      warns.push(this._warn(W.BAD_ASCII,
        "'ascii' solo es valido como valor de 'var' o argumento de un comando print (>f, >h, >`, etc.)."));
    }

    return this._block(B.ASCII, indent, content, [[T.KEYWORD, 'ascii']], {
      name: 'ascii', value: artLines.join('\n'), prefix: firstLine, warnings: warns,
    });
  }

  // ── PASS 1A: LINE SPLITTING ───────────────────────────────
  _splitLines(code) {
    const lines = code.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
    const out = [];
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];

      // A multiline block /* ... */ starts only when:
      // 1. The line is not a // line comment (// before /* means /* is inside the comment)
      // 2. /* appears with no code before it (only whitespace)
      // 3. The block does NOT close on the same line
      const isLineComment = line.trimStart().startsWith('//');
      const openIdx       = isLineComment ? -1 : line.indexOf('/*');
      const isBlockStart  = openIdx >= 0
        && line.slice(0, openIdx).trim() === ''
        && this._findCommentClose(line) === -1;

      if (isBlockStart) {
        let collected = line; i++;
        while (i < lines.length) {
          collected += '\n' + lines[i];
          if (this._findCommentClose(lines[i]) !== -1) { i++; break; }
          i++;
        }
        out.push(collected);
      } else {
        // Collapse ascii...asciiend into a single block
        const isAsciiStart = /\bascii\s*$/.test(line.split('//')[0]);
        if (isAsciiStart) {
          let collected = line; i++;
          while (i < lines.length) {
            collected += '\n' + lines[i];
            if (/^asciiend/.test(lines[i].trimStart())) { i++; break; }
            i++;
          }
          out.push(collected);
        } else {
          out.push(line); i++;
        }
      }
    }
    return out;
  }

  _findCommentClose(s) {
    let pos = 0;
    while (true) {
      const idx = s.indexOf('*/', pos);
      if (idx === -1) return -1;
      if (idx > 0 && s[idx - 1] === '\\') { pos = idx + 2; continue; }
      return idx;
    }
  }

  // ── PASS 1B: LINE PARSER ──────────────────────────────────
  _parseLine(rawLine) {
    if (rawLine.includes('\n')) {
      const indent = this._leadingSpaces(rawLine);
      const content = rawLine.trimStart();
      if (this._isAsciiBlock(content)) {
        return this._parseAsciiBlock(indent, content);
      }
      return this._block(B.COMMENT, indent, content, [[T.COMMENT, content]]);
    }
    const indent  = this._leadingSpaces(rawLine);
    const content = rawLine.slice(indent);
    if (content === '' || content.trim() === '') return this._block(B.EMPTY, indent, '', []);

    // ^ continuation
    if (content[0] === '^') {
      const rest     = content.slice(1).trimStart();
      const tokens   = [[T.CONTINUE, '^'], ...this._tokenizeExpr(content.slice(1))];
      const warnings = this._checkContinuation(rest);
      return this._block(B.CONTINUE, indent, content, tokens, { warnings });
    }

    if (content.startsWith('/*') && this._findCommentClose(content) !== -1)
      return this._block(B.COMMENT, indent, content, [[T.COMMENT, content]]);
    if (content.startsWith('//'))
      return this._block(B.COMMENT, indent, content, [[T.COMMENT, content]]);

    // :? elseif
    if (content.startsWith(':?')) {
      const after = content.slice(2), expr = after.trimStart();
      const warnings = [
        ...(expr === '' ? [this._warn(W.EMPTY_EXPR, 'La condicion :? esta vacia')] : []),
        ...this._checkConditionExpr(expr),
      ];
      return this._block(B.ELSEIF, indent, content,
        [[T.CONTROL, ':?'], ...this._tokenizeExpr(after)], { value: expr, warnings });
    }

    // : else — valid forms:
    //   ':'           bare else
    //   ': '          else with trailing space (before comment)
    //   ':// ...'     else with inline // comment (no space required)
    //   ':/* ... */'  else with inline /* comment
    // Anything else after ':' (e.g. ':/foo', ':bar') is invalid.
    if (content[0] === ':') {
      const afterColon = content.slice(1);
      const trimmed    = afterColon.trimStart();
      const isValid    = afterColon === ''
        || trimmed.startsWith('//')
        || trimmed.startsWith('/*');
      const tokens = [[T.CONTROL, ':']];
      if (afterColon.trim()) tokens.push(...this._tokenizeExpr(afterColon));
      const warns = isValid ? [] : [this._warn(W.BAD_EXPR,
        `Sintaxis invalida tras ':'. Solo se permite ':' solo, ': // comentario' o ': /* comentario */'.`)];
      return this._block(B.ELSE, indent, content, tokens, { warnings: warns });
    }

    // ? condition
    if (content[0] === '?') {
      const after = content.slice(1), expr = after.trimStart();
      const warnings = [
        ...(expr === '' ? [this._warn(W.EMPTY_EXPR, 'La condicion ? esta vacia')] : []),
        ...this._checkConditionExpr(expr),
      ];
      return this._block(B.CONDITION, indent, content,
        [[T.CONTROL, '?'], ...this._tokenizeExpr(after)], { value: expr, warnings });
    }

    // Print prefixes
    for (const pfx of this.printPfx) {
      if (content.startsWith(pfx)) {
        const arg    = content.slice(pfx.length);
        const tokens = [[T.PRINT, pfx]];
        if (arg !== '') tokens.push([T.STRING, arg]);
        return this._block(B.PRINT, indent, content, tokens,
          { name: pfx, value: arg, def: this.byId[pfx] || null });
      }
    }

    // Multi-word commands
    const lcContent = content.toLowerCase();
    for (const mc of this.multiCmds) {
      if (lcContent.startsWith(mc.toLowerCase())) {
        const rest = content.slice(mc.length), arg = rest.trimStart();
        const def  = this.byId[mc] || null;
        const warnings = this._checkFollow(def, arg);
        const tokens   = [[T.COMMAND, content.slice(0, mc.length)]];
        if (arg !== '') { tokens.push([T.SPACE, ' ']); tokens.push(...this._tokenizeArg(arg, def)); }
        return this._block(B.COMMAND, indent, content, tokens, { name: mc, value: arg, def, warnings });
      }
    }

    if (/^[a-zA-Z_]/.test(content)) return this._parseWordLine(indent, content);
    return this._block(B.RAW, indent, content, this._tokenizeExpr(content));
  }

  _parseWordLine(indent, content) {
    const m = content.match(/^([a-zA-Z_][a-zA-Z0-9_.]*)(.*)$/s);
    const word = m[1], rest = m[2] || '', lc = word.toLowerCase();

    if (lc === 'func') {
      const sig      = rest.trimStart();
      const spaces   = rest.slice(0, rest.length - rest.trimStart().length);
      const warnings = this._checkFuncSig(sig);
      return this._block(B.FUNC_DEF, indent, content,
        [[T.KEYWORD, 'func'], [T.SPACE, spaces || ' '], ...this._tokenizeFuncSig(sig)],
        { name: 'func', value: sig, warnings });
    }
    if (lc === 'for') {
      const expr   = rest.trimStart();
      const spaces = rest.slice(0, rest.length - rest.trimStart().length);
      return this._block(B.FOR_LOOP, indent, content,
        [[T.KEYWORD, 'for'], [T.SPACE, spaces || ' '], ...this._tokenizeExpr(expr)],
        { name: 'for', value: expr });
    }
    if (this.keywords.includes(lc)) {
      const arg    = rest.trimStart(), def = this.byId[lc] || null;
      const tokens = [[T.KEYWORD, word]];
      if (arg !== '') {
        // Preserve the original whitespace between keyword and argument
        const spaces = rest.slice(0, rest.length - rest.trimStart().length);
        tokens.push([T.SPACE, spaces || ' ']);
        tokens.push(...this._tokenizeExpr(arg));
      }
      const warnings = this._checkKeyword(lc, arg, def);
      return this._block(B.KEYWORD, indent, content, tokens, { name: word, value: arg, def, warnings });
    }
    if (this.commands.includes(lc)) {
      const arg    = rest.trimStart(), def = this._lookupCommand(word);
      const warnings = [...this._checkFollow(def, arg), ...this._checkCommand(lc, arg, def)];
      const tokens   = [[T.COMMAND, word]];
      if (arg !== '') {
        const spaces = rest.slice(0, rest.length - rest.trimStart().length);
        tokens.push([T.SPACE, spaces || ' ']);
        tokens.push(...this._tokenizeArg(arg, def));
      }
      return this._block(B.COMMAND, indent, content, tokens, { name: word, value: arg, def, warnings });
    }
    if (rest.trimStart().startsWith('(')) return this._parseFuncCall(indent, content, word, rest.trimStart());
    if (/^\s*[+\-*\/]?=/.test(rest) || rest.trimStart().startsWith('++') || rest.trimStart().startsWith('--')) {
      const tokens   = [...this._resolveIdentToken(word), ...this._tokenizeExpr(rest)];
      const warnings = this._checkAssignment(word);
      return this._block(B.ASSIGN, indent, content, tokens, { name: word, value: rest.trim(), warnings });
    }

    // Bare word: Rule 3 (bad statement) + Rule 7 (sealed prop)
    const warnings = this._checkBareWord(word, rest);
    const tokens   = [...this._resolveIdentToken(word), ...this._tokenizeExpr(rest)];
    return this._block(B.RAW, indent, content, tokens, { name: word, warnings });
  }

  _parseFuncCall(indent, content, name, rest) {
    const def      = this._lookupFuncOrVar(name);
    const tokens   = [...this._resolveIdentToken(name), ...this._tokenizeCallArgs(rest, def)];
    const warnings = [
      ...((def && def.args && !def.overloads) ? this._checkArgCount(def, rest) : []),
      ...((def && def.args && !def.overloads) ? this._checkArgTypes(def, rest) : []),
      ...this._checkSealedProp(name),
      ...this._checkCallTrailingJunk(rest),
    ];
    return this._block(B.CALL, indent, content, tokens, { name, value: rest, def, warnings });
  }

  // Detect junk after a function call: test() aoeu
  _checkCallTrailingJunk(callStr) {
    const s = callStr.trimStart();
    if (!s.startsWith('(')) return [];
    let depth = 1, i = 1;
    while (i < s.length && depth > 0) {
      if (s[i] === '(') depth++;
      else if (s[i] === ')') depth--;
      i++;
    }
    const after = s.slice(i).trim();
    if (!after) return [];
    if (after.startsWith('//') || after.startsWith('/*')) return [];
    if (/^[=!<>&|+\-*\/%]/.test(after)) return [];
    return [this._warn(W.BAD_EXPR,
      `Token inesperado tras la llamada: '${after}'.`)];
  }

  // ── PASS 1C: TREE BUILDER ─────────────────────────────────
  _buildTree(flat) {
    const blocks = flat.map(b => ({ ...b, children: [], warnings: [...b.warnings] }));
    const n      = blocks.length;
    const stack  = [{ blockIdx: null, childIndent: null, parentIndent: -1 }];
    for (let bi = 0; bi < n; bi++) {
      const type    = blocks[bi].type;
      const indent  = blocks[bi].indent;
      const trivial = TRIVIAL_TYPES.includes(type);
      if (!trivial) {
        while (stack.length > 1) {
          const top = stack[stack.length - 1];
          if (top.childIndent === null && indent > top.parentIndent) break;
          if (top.childIndent !== null && indent === top.childIndent) break;
          if (top.childIndent !== null && indent > top.childIndent) break;
          if (top.childIndent === null && top.blockIdx !== null)
            blocks[top.blockIdx].warnings.push(
              this._warn(W.EMPTY_BLOCK, 'El bloque esta vacio (no hay lineas con mayor indentacion)'));
          stack.pop();
        }
        const top = stack[stack.length - 1], si = stack.length - 1;
        if (si === 0 && indent > 0 && type !== B.COMMENT)
          blocks[bi].warnings.push(this._warn(W.ORPHAN, 'Espaciado inconsistente: no hay condicion ni funcion padre'));
        else if (top.childIndent === null) stack[si].childIndent = indent;
        else if (indent !== top.childIndent)
          blocks[bi].warnings.push(this._warn(W.INCONSISTENT,
            `El espaciado no coincide con la linea anterior (esperado ${top.childIndent}, encontrado ${indent})`));
      }
      const top = stack[stack.length - 1];
      if (top.blockIdx !== null) blocks[top.blockIdx].children.push(bi);
      if (!trivial && SCOPE_OPENERS.includes(type))
        stack.push({ blockIdx: bi, childIndent: null, parentIndent: indent });
    }
    for (let i = stack.length - 1; i >= 1; i--) {
      const f = stack[i];
      if (f.childIndent === null && f.blockIdx !== null)
        blocks[f.blockIdx].warnings.push(
          this._warn(W.EMPTY_BLOCK, 'El bloque esta vacio (no hay lineas con mayor indentacion)'));
    }
    return this._resolveTree(blocks);
  }

  _resolveTree(blocks) {
    const childSet = new Set();
    for (const b of blocks) for (const ci of b.children) childSet.add(ci);
    const result = [];
    for (let i = 0; i < blocks.length; i++)
      if (!childSet.has(i)) result.push(this._nestBlock(blocks, i));
    return result;
  }
  _nestBlock(blocks, idx) {
    const b = { ...blocks[idx] };
    b.children = b.children.map(ci => this._nestBlock(blocks, ci));
    return b;
  }

  // ── TOKENIZERS ────────────────────────────────────────────
  _tokenizeExpr(expr) {
    const tokens = []; let pos = 0;
    while (pos < expr.length) {
      const rest = expr.slice(pos), c = rest[0];
      if (rest.startsWith('//')) { tokens.push([T.COMMENT, rest]); break; }
      if (rest.startsWith('/*')) {
        const close = this._findCommentClose(rest);
        const val   = close !== -1 ? rest.slice(0, close + 2) : rest;
        tokens.push([T.COMMENT, val]); pos += val.length; continue;
      }
      if (c === ' ' || c === '\t') {
        let ws = '';
        while (pos < expr.length && (expr[pos] === ' ' || expr[pos] === '\t')) ws += expr[pos++];
        tokens.push([T.SPACE, ws]); continue;
      }
      if (c === '@') {
        const end = expr.indexOf('@', pos + 1);
        if (end !== -1) { tokens.push([T.IDENTIFIER, expr.slice(pos, end + 1)]); pos = end + 1; }
        else            { tokens.push([T.IDENTIFIER, rest]); pos = expr.length; }
        continue;
      }
      if (c === '"') {
        const end = expr.indexOf('"', pos + 1);
        if (end !== -1) { tokens.push([T.STRING, expr.slice(pos, end + 1)]); pos = end + 1; }
        else            { tokens.push([T.STRING, rest]); pos = expr.length; }
        continue;
      }
      let matched = false;
      for (const op of this.operators) {
        if (op === ':?') continue;
        if (rest.startsWith(op)) { tokens.push([T.OPERATOR, op]); pos += op.length; matched = true; break; }
      }
      if (matched) continue;
      if ('()'.includes(c)) { tokens.push([T.PAREN, c]);   pos++; continue; }
      if ('[]'.includes(c)) { tokens.push([T.BRACKET, c]); pos++; continue; }
      if (/\d/.test(c) || (c === '-' && pos + 1 < expr.length && /\d/.test(expr[pos + 1]))) {
        const nm = rest.match(/^-?\d+(\.\d+)?/);
        tokens.push([T.NUMBER, nm[0]]); pos += nm[0].length; continue;
      }
      if (/[a-zA-Z_]/.test(c)) {
        const wm = rest.match(/^[a-zA-Z_][a-zA-Z0-9_.]*/), word = wm[0];
        pos += word.length;
        if (pos < expr.length && expr[pos] === '(') {
          const def = this._lookupFuncOrVar(word);
          tokens.push([(def && def.type === 'func') ? T.FUNCTION : T.IDENTIFIER, word]);
          let depth = 1, inner = '('; pos++;
          while (pos < expr.length && depth > 0) {
            const ch = expr[pos]; inner += ch;
            if (ch === '(') depth++; else if (ch === ')') depth--;
            pos++;
          }
          tokens.push(...this._tokenizeCallArgs(inner, def));
        // Arg count + type check inline (e.g. inside condition expressions)
        if (def && def.args && !def.overloads) {
          if (!this._inlineArgWarnings) this._inlineArgWarnings = [];
          const callStr = '(' + inner.slice(1); // inner already starts with '('
          this._checkArgCount(def, callStr).forEach(w => this._inlineArgWarnings.push(w));
          this._checkArgTypes(def, callStr).forEach(w => this._inlineArgWarnings.push(w));
        }
        continue;
        }
        tokens.push(...this._resolveIdentToken(word)); continue;
      }
      tokens.push([T.STRING, c]); pos++;
    }
    return tokens;
  }

  _tokenizeCallArgs(callStr, def) {
    const s = callStr.trimStart();
    if (!s.startsWith('(')) return this._tokenizeExpr(callStr);
    const tokens = [[T.PAREN, '(']];
    let depth = 1, inner = '', i = 1;
    while (i < s.length && depth > 0) {
      const ch = s[i];
      if (ch === '(') depth++;
      else if (ch === ')') { depth--; if (depth === 0) { i++; break; } }
      inner += ch; i++;
    }
    if (inner !== '') tokens.push(...this._tokenizeExpr(inner));
    tokens.push([T.PAREN, ')']);
    const after = s.slice(i);
    if (after.trim() !== '') tokens.push(...this._tokenizeExpr(after));
    return tokens;
  }

  _tokenizeArg(arg, def) {
    const follows = def && def.follows ? def.follows : '';
    switch (follows) {
      case 'number': case 'expr': return this._tokenizeExpr(arg);
      case 'search_string':       return [[T.STRING, arg]];
      case 'func_signature':      return this._tokenizeFuncSig(arg);
      case 'ability_id': case 'sound_id': return [[T.IDENTIFIER, arg]];
      default: return [[T.STRING, arg]];
    }
  }

  _tokenizeFuncSig(sig) {
    const m = sig.trim().match(/^([a-zA-Z_][a-zA-Z0-9_]*)(\(.*\))?$/);
    if (!m) return [[T.IDENTIFIER, sig]];
    const tokens = [[T.IDENTIFIER, m[1]]];
    if (m[2]) {
      const inner = m[2].slice(1, -1);
      tokens.push([T.PAREN, '(']);
      inner.split(',').map(p => p.trim()).forEach((p, j) => {
        if (j) { tokens.push([T.STRING, ',']); tokens.push([T.SPACE, ' ']); }
        if (p) tokens.push([T.IDENTIFIER, p]);
      });
      tokens.push([T.PAREN, ')']);
    }
    return tokens;
  }

  // ── LOOKUP HELPERS ────────────────────────────────────────
  _resolveIdentToken(word) {
    const def = this._lookupFuncOrVar(word);
    if (def) return [[(def.type === 'func' ? T.FUNCTION : T.VARIABLE), word]];
    const root = word.split('.')[0];
    if (this.varRoots.includes(root)) return [[T.VARIABLE, word]];
    return [[T.IDENTIFIER, word]];
  }
  _lookupFuncOrVar(name) {
    if (this.byId[name]) return this.byId[name];
    const bare = name.replace(/\(.*$/s, '');
    if (this.byId[bare]) return this.byId[bare];
    return null;
  }
  _lookupCommand(name) {
    const lc = name.toLowerCase();
    return this.api.find(e => e.type === 'command' && e.id.toLowerCase() === lc) || null;
  }

  // ── VALIDATION (data-driven) ──────────────────────────────

  // Rule 1+2: condition expression validation
  // Uses condValidate loaded from ?.validate in JSON
  _checkConditionExpr(expr) {
    if (!expr) return [];
    const warns = [];
    this._inlineArgWarnings = []; // reset before tokenizing this expression

    // Semicolons (and other explicitly invalid chars)
    if (INVALID_EXPR_CHARS.test(expr))
      warns.push(this._warn(W.BAD_EXPR,
        `Caracter invalido en la expresion: '${expr.match(INVALID_EXPR_CHARS)[0]}'. ` +
        `Las condiciones no admiten ';'. Usa '&' para combinar condiciones.`));

    // Double/invalid operator sequences (==, =!, !!, =<, etc.)
    // Read valid ops from the JSON condValidate if available
    const doubleOps = expr.match(/[=!<>]{2,}/g);
    if (doubleOps) {
      for (const seq of doubleOps) {
        if (!this.validConditionOps.has(seq))
          warns.push(this._warn(W.BAD_OPERATOR,
            `Operador invalido: '${seq}'. Operadores validos: = ! < > <= >= & |`));
      }
    }

    // Embedded ? (condition inside expression: ?klk?manin)
    // JSON: condValidate.no_embedded_condition
    if (this.condValidate.no_embedded_condition && expr.includes('?'))
      warns.push(this._warn(W.BAD_EXPR,
        `'?' no puede aparecer dentro de una expresion de condicion.`));

    // Keywords as operands (var, func, return…)
    // JSON: condValidate.no_keywords_as_operands + __validation__.keywords_not_allowed_in_expr
    if (this.condValidate.no_keywords_as_operands && this.keywordsNotInExpr.size) {
      // Tokenize the expression and look for keyword-type identifiers
      const words = expr.match(/\b[a-zA-Z_][a-zA-Z0-9_]*\b/g) || [];
      for (const w of words) {
        if (this.keywordsNotInExpr.has(w.toLowerCase()))
          warns.push(this._warn(W.BAD_EXPR,
            `'${w}' es una palabra reservada y no puede usarse como operando en una condicion.`));
      }
    }

    // Bare string without operator (e.g. ?foe "skeleton")
    // JSON: condValidate.no_bare_string
    if (this.condValidate.no_bare_string) {
      // Detect: identifier/variable followed directly by a quoted string with no operator between
      if (/[a-zA-Z0-9_]\s+"/.test(expr) || /[a-zA-Z0-9_]\s+'/.test(expr))
        warns.push(this._warn(W.BAD_EXPR,
          `String literal sin operador. Usa un operador de comparacion: = ! < > <= >=`));
    }

    // Sealed property access inside the expression (e.g. ?foe.test>0)
    const dottedWords = expr.match(/\b[a-zA-Z_][a-zA-Z0-9_.]*\b/g) || [];
    for (const dw of dottedWords) {
      if (!dw.includes('.')) continue;
      warns.push(...this._checkSealedProp(dw));
    }

    // Trailing junk (e.g. ?hp<foe.hp aoeu)
    warns.push(...this._checkCondTrailingJunk(expr));

    // Collect any inline arg type warnings from _tokenizeExpr
    if (this._inlineArgWarnings && this._inlineArgWarnings.length) {
      warns.push(...this._inlineArgWarnings);
      this._inlineArgWarnings = [];
    }

    return warns;
  }

  // Rule: continuation (^) must start with & | ( .
  // JSON: __validation__.continuation_must_start_with
  _checkContinuation(rest) {
    if (!rest || !this.continuationStartsWith.size) return [];
    const first = rest[0];
    if ([...this.continuationStartsWith].some(s => rest.startsWith(s))) return [];
    return [this._warn(W.BAD_CONTINUE,
      `Una linea de continuacion ^ debe empezar con & o | (conector logico) ` +
      `o con ( o . (continuacion de expresion). ` +
      `Se encontro: '${rest.slice(0, 10)}'`)];
  }

  // Rule 3 + 7: bare identifier on its own line
  _checkBareWord(word, rest) {
    const sealedWarn = this._checkSealedProp(word);
    if (sealedWarn.length) return sealedWarn;
    if (rest.trim() !== '') return [];
    const def      = this._lookupFuncOrVar(word);
    const root     = word.split('.')[0];
    const isNative = def || this.varRoots.includes(root);
    if (isNative)
      return [this._warn(W.BAD_STATEMENT,
        `'${word}' es una variable/funcion nativa pero no es un statement valido. ` +
        `Usala en una condicion (?${word}) o asignacion (var x = ${word}).`)];
    return [this._warn(W.UNKNOWN_CMD,
      `'${word}' no es un comando, variable ni funcion reconocida.`)];
  }

  // Rule 7: sealed group property check
  _checkSealedProp(name) {
    if (!name.includes('.')) return [];
    const root = name.split('.')[0];
    if (!this.sealedGroups.has(root)) return [];
    if (this.byId[name]) return [];
    const bare = name.replace(/\(.*$/s, '');
    if (this.byId[bare]) return [];
    const known = this.api.some(e => (e.type === 'var' || e.type === 'func') && e.id === name);
    if (known) return [];
    return [this._warn(W.SEALED_PROP,
      `'${name}' no existe. '${root}' es una variable nativa sellada — ` +
      `sus propiedades estan fijadas por el juego.`)];
  }

  // Rule 4: import validation — reads from importValidate (JSON)
  // '//' always starts a comment in Stonescript (with or without space before it).
  // So 'import valido//comment' → path is 'valido', comment is '//comment'.
  // But 'import test//bad' also strips to 'test' which is valid —
  // the double-slash in the path is swallowed by the comment strip.
  // This matches Stonescript's actual behaviour: // is always a comment delimiter.
  _checkImport(path) {
    // Strip everything from // onward (always a comment)
    const commentIdx = path.indexOf('//');
    const stripped   = (commentIdx >= 0 ? path.slice(0, commentIdx) : path).trim();
    if (!stripped) return [];
    // Spaces inside (after strip+trim): genuine error
    if (this.importValidate.no_spaces && /\s/.test(stripped))
      return [this._warn(W.BAD_IMPORT,
        `La ruta '${stripped}' no puede contener espacios.`)];
    if (this.importValidate.pattern) {
      const re = new RegExp(this.importValidate.pattern);
      if (!re.test(stripped))
        return [this._warn(W.BAD_IMPORT,
          `La ruta '${stripped}' no es valida. ` +
          (this.importValidate.pattern_desc || `Segmentos separados por un solo /. Solo letras, digitos, _ . -`))];
    }
    return [];
  }

  // Rule 5: var declaration validation — reads from varValidate (JSON)
  _checkVarDecl(arg) {
    const trimmed = arg.trim();
    if (!trimmed) return [];

    // Split name from value: var name = value  or  var name
    const eqIdx  = trimmed.indexOf('=');
    const namePart = (eqIdx >= 0 ? trimmed.slice(0, eqIdx) : trimmed).trim();
    const valPart  = eqIdx >= 0 ? trimmed.slice(eqIdx + 1).trim() : '';

    // Multiple declarations: var a,b
    if (/,/.test(namePart))
      return [this._warn(W.BAD_VAR,
        `Solo se puede declarar una variable a la vez. Usa una linea 'var' por variable.`)];

    // Extra words in the name part: var a b = ...
    if (/\s/.test(namePart))
      return [this._warn(W.BAD_VAR,
        `Solo se puede declarar una variable a la vez. Usa una linea 'var' por variable.`)];

    const name = namePart;

    // Valid identifier
    const pattern = this.varValidate.identifier_pattern || '^[a-zA-Z_][a-zA-Z0-9_]*$';
    if (!new RegExp(pattern).test(name))
      return [this._warn(W.BAD_VAR,
        `'${name}' no es un nombre de variable valido. ` +
        `Debe empezar por letra o _ y solo contener letras a-z A-Z, digitos 0-9 y _.`)];

    // Reserved native name
    if (this.reservedNames.has(name))
      return [this._warn(W.BAD_VAR,
        `'${name}' es una variable nativa del juego y no puede usarse como nombre de variable.`)];

    // Junk after value: var test = aoeu aoeu
    // Exception: var x = import Some/Path is valid (stored import reference)
    if (this.varValidate.no_junk_after_value && valPart) {
      if (/^import\s/.test(valPart.trim())) {
        const pathMatch = valPart.trim().match(/^import\s+(.*)/);
        if (pathMatch) return this._checkImport(pathMatch[1]);
        return [];
      }
      const junk = this._detectExprJunk(valPart);
      if (junk) return [this._warn(W.BAD_VAR,
        `Valor de variable invalido: '${valPart}'. ` +
        `Token inesperado: '${junk}'. Si es una cadena, usa comillas: var ${name} = "${valPart}"`)];
    }

    return [];
  }

  // Detect trailing junk in an expression value: multiple words without operator
  // Skips tokens inside () and [] — those are function args or array elements, not junk.
  // Returns the junk word or null if clean
  _detectExprJunk(val) {
    const tokens     = this._tokenizeExpr(val);
    const VALUE_TYPES = new Set(['identifier','variable','number','string']);
    let lastType = null;
    let depth    = 0;
    for (const [type, value] of tokens) {
      if (type === 'space' || type === 'comment') continue;
      if (type === 'paren'   && value === '(') { depth++; lastType = null; continue; }
      if (type === 'paren'   && value === ')') { depth = Math.max(0,depth-1); lastType='paren'; continue; }
      if (type === 'bracket' && value === '[') { depth++; lastType = null; continue; }
      if (type === 'bracket' && value === ']') { depth = Math.max(0,depth-1); lastType='bracket'; continue; }
      if (depth > 0) continue; // inside () or [] — skip junk check
      if (VALUE_TYPES.has(type) && VALUE_TYPES.has(lastType)) {
        return value;
      }
      lastType = type;
    }
    return null;
  }

  // Rule 6: activate — data-driven from activate.arg_validation in JSON
  // fixed_values: always valid (l/r/p/left/right/potion)
  // known_ability_ids: known item ability ids (bardiche, bash...)
  // charset: what chars are allowed at all
  _checkActivate(arg) {
    if (!arg.trim()) return [];
    const val = arg.trim();
    const lc  = val.toLowerCase();

    // Multi-word: never valid
    if (/\s/.test(val))
      return [this._warn(W.BAD_ACTIVATE,
        `'${val}' no puede contener espacios. ` +
        `Fijos validos: ${[...this.abilityFixed].join(', ')}.`)];

    // Charset check (from activate.arg_validation.charset in JSON)
    if (!this.abilityCharset.test(val))
      return [this._warn(W.BAD_ACTIVATE,
        `'${val}' contiene caracteres no validos. ` +
        `Solo se permiten letras a-z A-Z, digitos y _.`)];

    // Fixed values are always valid (case-insensitive)
    if (this.abilityFixed.has(lc)) return [];

    // Known ability IDs are valid
    if (this.abilityKnown.has(lc)) return [];

    // Unknown — report error with both lists
    const all = [...this.abilityFixed, ...this.abilityKnown].sort();
    return [this._warn(W.BAD_ACTIVATE,
      `'${val}' no es un ability ID reconocido. ` +
      `Fijos: ${[...this.abilityFixed].join(', ')}. ` +
      `Conocidos: ${[...this.abilityKnown].join(', ')}.`)];
  }

  // Rule: func signature — name must be valid identifier, no trailing junk
  // Data-driven: func.validate.name_pattern and no_trailing_junk from JSON
  _checkFuncSig(sig) {
    const trimmed = sig.trim();
    const warns   = [];
    const nameMatch = trimmed.match(/^([^\s(]+)/);
    if (nameMatch) {
      const name        = nameMatch[1];
      const namePattern = this.funcValidate.name_pattern || '^[a-zA-Z_][a-zA-Z0-9_]*$';
      if (!new RegExp(namePattern).test(name))
        warns.push(this._warn(W.BAD_VAR,
          `'${name}' no es un nombre de funcion valido. ` +
          (this.funcValidate.name_pattern_desc ||
           'Solo letras a-z A-Z, digitos y _. No puede empezar por numero.')));
    }
    if (this.funcValidate.no_trailing_junk !== false) {
      const m = trimmed.match(/^[^\s(]*\s*\([^)]*\)\s*(.*)/);
      if (m) {
        const trailing = m[1].trim();
        if (trailing && !trailing.startsWith('//') && !trailing.startsWith('/*'))
          warns.push(this._warn(W.BAD_EXPR,
            `Tokens inesperados tras la firma de la funcion: '${trailing}'.`));
      }
    }
    return warns;
  }

  // Rule: assignment to native (sealed) variable
  // Data-driven: non_assignable_roots from __validation__ in JSON
  _checkAssignment(name) {
    const root = name.split('.')[0];
    if (this.nonAssignableRoots.has(root))
      return [this._warn(W.BAD_STATEMENT,
        `'${name}' es una variable nativa y no puede ser asignada.`)];
    // Also check sealed prop for dotted names (foe.hello = 2)
    return this._checkSealedProp(name);
  }

  // Rule: no trailing junk after condition expression
  // e.g. ?hp<foe.hp aoeu  → 'aoeu' has no operator before it
  // e.g. ?test() aeuo     → 'aeuo' follows ')' with no operator
  // Rule: no trailing junk after condition expression
  // Tokens inside function call parentheses are skipped (they are arguments, not junk)
  // Rule: no trailing junk after condition expression
  // Tokens inside () and [] are skipped. Dot as method separator resets context.
  _checkCondTrailingJunk(expr) {
    if (!expr || !this.condValidate.no_trailing_junk) return [];
    const tokens = this._tokenizeExpr(expr);
    let lastMeaningful = null;
    let depth    = 0;
    let inRHS    = false; // after a comparison op, skip until logical op or end
    const COMPARISON_OPS = new Set(['=', '!', '<', '>', '<=', '>=']);
    const LOGICAL_OPS    = new Set(['&', '|']);
    for (const [type, value] of tokens) {
      if (type === 'space' || type === 'comment') continue;
      if (type === 'paren') {
        if (value === '(') { depth++; if (depth === 1) inRHS = false; lastMeaningful = null; }
        else { depth = Math.max(0, depth - 1); if (depth === 0) lastMeaningful = 'paren'; }
        continue;
      }
      if (type === 'bracket') {
        if (value === '[') { depth++; lastMeaningful = null; }
        else { depth = Math.max(0, depth - 1); if (depth === 0) lastMeaningful = 'bracket'; }
        continue;
      }
      if (depth > 0) continue; // inside () or [] — skip
      // Logical operators end the RHS and reset context
      if (type === 'operator' && LOGICAL_OPS.has(value)) {
        inRHS = false; lastMeaningful = 'operator'; continue;
      }
      // Comparison operators start an RHS — everything after is the value string
      if (type === 'operator' && COMPARISON_OPS.has(value)) {
        inRHS = true; lastMeaningful = 'operator'; continue;
      }
      if (inRHS) continue; // inside RHS — multi-word values like 'haunted halls' are valid
      // '.' as string is a method access separator — resets junk context
      if (type === 'string' && value === '.') { lastMeaningful = null; continue; }
      if ((type === 'identifier' || type === 'variable') &&
          lastMeaningful &&
          ['identifier','variable','number','string','paren','bracket'].includes(lastMeaningful)) {
        return [this._warn(W.BAD_EXPR,
          `Token inesperado en la condicion: '${value}'. ` +
          `Falta un operador (= ! < > <= >= & |) antes de este valor.`)];
      }
      lastMeaningful = type;
    }
    return [];
  }

  // Dispatch keyword validations
  _checkKeyword(lc, arg, def) {
    if (lc === 'import') return this._checkImport(arg);
    if (lc === 'var')    return this._checkVarDecl(arg);
    if (lc === 'asciiend') return [this._warn(W.BAD_ASCII, "'asciiend' sin bloque 'ascii' previo.")];
    return [];
  }
  _checkCommand(lc, arg, def) {
    if (lc === 'activate') return this._checkActivate(arg);
    return [];
  }

  // ── LEGACY VALIDATION ─────────────────────────────────────
  _checkFollow(def, arg) {
    if (!def || !def.follows) return [];
    if (arg.trim() !== '') return [];
    const args     = def.args || [];
    const required = args.length === 0 ? 1 : args.filter(a => !a.optional).length;
    if (!required) return [];
    return [this._warn(W.BAD_FOLLOW, `'${def.id}' requiere un argumento (${def.follows})`)];
  }
  // Validate argument types against the function signature (data-driven from JSON)
  // Only checks literal values — variables/expressions are always accepted.
  _checkArgTypes(def, callStr) {
    if (!this.argTypeCheckEnabled || !def.args) return [];
    const m = callStr.trim().match(/^\((.*?)\)$/s);
    if (!m) return [];
    const inner = m[1].trim();
    if (!inner) return [];

    // Split args respecting nested parens/brackets
    const rawArgs = [];
    let depth = 0, cur = '';
    for (const ch of inner + ',') {
      if (ch === '(' || ch === '[') { depth++; cur += ch; }
      else if (ch === ')' || ch === ']') { depth--; cur += ch; }
      else if (ch === ',' && depth === 0) { rawArgs.push(cur.trim()); cur = ''; }
      else cur += ch;
    }

    const warns = [];
    for (let i = 0; i < Math.min(rawArgs.length, def.args.length); i++) {
      const argDef  = def.args[i];
      const argVal  = rawArgs[i];
      if (!argVal || !argDef.type) continue;

      // Determine the token type of the literal value
      const tokenType = this._classifyArgValue(argVal);
      if (!tokenType) continue;      // complex expression — skip
      if (tokenType === 'variable') continue; // variable — type unknown at parse time, skip

      const rules = this.argTypeRules[argDef.type];
      if (!rules) continue; // unknown type — skip

      const validTokens = rules.valid_tokens || [];
      if (!validTokens.includes(tokenType)) {
        // bool: 'true'/'false' are classified as 'bool' by _classifyArgValue
        if (argDef.type === 'bool' && tokenType === 'bool') continue;
        // number/int/float: all accept numeric literals
        if (['number','int','float'].includes(argDef.type) && tokenType === 'number') continue;
        warns.push(this._warn(W.BAD_ARG_TYPE,
          `Argumento '${argDef.name}' de '${def.id}': se esperaba ${argDef.type}, ` +
          `se recibio ${tokenType} ('${argVal.slice(0,20)}')`));
      }
    }
    return warns;
  }

  // Classify a single argument value as a token type.
  // Returns null if the value is a complex expression (safe to skip type check).
  _classifyArgValue(val) {
    const v = val.trim();
    if (!v) return null;
    if (/^".*"$/.test(v) || /^'.*'$/.test(v)) return 'string'; // string literal
    if (/^-?\d+(\.\d+)?$/.test(v)) return 'number';           // numeric literal
    if (v === 'true' || v === 'false') return 'bool';
    if (/^[a-zA-Z_][a-zA-Z0-9_.]*$/.test(v)) return 'variable'; // simple var/func name
    return null; // complex expression — skip
  }

  _checkArgCount(def, callStr) {
    const m = callStr.trim().match(/^\((.*)\)$/s);
    if (!m) return [];
    const inner    = m[1].trim();
    const count    = inner === '' ? 0 : inner.split(/,(?![^(]*\))/).length;
    const args     = def.args || [];
    const required = args.filter(a => !a.optional).length;
    const total    = args.length;
    if (count < required || count > total)
      return [this._warn(W.ARG_COUNT,
        `'${def.id}' espera entre ${required} y ${total} argumento(s), se encontraron ${count}`)];
    return [];
  }

  // ── PASS 2: HTML RENDERER ─────────────────────────────────
  _blockToHtml(block, depth = 0) {
    if (block.type === B.EMPTY) return '';
    if (block.type === B.ASCII) return this._asciiBlockToHtml(block);
    const indent    = ' '.repeat(block.indent);
    const preWarns  = block.warnings
      .filter(w => w.type !== W.EMPTY_EXPR && w.type !== W.EMPTY_BLOCK && w.severity !== 'warning')
      .map(w => this._warnSpan('\u26a0', w.message, 'error')).join('');
    const preWarnsW = block.warnings
      .filter(w => w.type !== W.EMPTY_EXPR && w.type !== W.EMPTY_BLOCK && w.severity === 'warning')
      .map(w => this._warnSpan('\u25b2', w.message, 'warning')).join('');
    const postWarns = block.warnings
      .filter(w => (w.type === W.EMPTY_EXPR || w.type === W.EMPTY_BLOCK) && w.severity !== 'warning')
      .map(w => this._warnSpan('?', w.message, 'error')).join('');
    let html = indent + preWarns + preWarnsW + this._renderTokens(block.tokens) + postWarns;
    for (const child of block.children) {
      const ch = this._blockToHtml(child, depth + 1);
      if (ch !== '') html += '\n' + ch;
    }
    return html;
  }
  _asciiBlockToHtml(block) {
    const lines  = (block.raw || '').split('\n');
    const indent = ' '.repeat(block.indent);
    const warns  = block.warnings.map(w => this._warnSpan('\u26a0', w.message)).join('');
    const out    = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (i === 0) {
        // First line: everything before 'ascii' keyword + the keyword itself
        // Capture prefix AND any spaces between prefix and 'ascii'
        // e.g. 'var ear =  [  ascii' → prefix='var ear =  [', spaces='  ', kw='ascii'
        const m = line.match(/^(\s*)(.*?)(\s+)(ascii)(\s*)$/);
        if (m) {
          // m[2]=prefix content, m[3]=spaces before ascii, m[4]='ascii', m[5]=trailing
          const pre = m[2] ? this._renderLineAsTokens(m[2]) + this._esc(m[3]) : this._esc(m[3]);
          out.push(indent + warns + pre + '<span class="keyword">ascii</span>');
        } else {
          // ascii is the whole line (no prefix)
          out.push(indent + warns + '<span class="keyword">ascii</span>');
        }
      } else if (/^asciiend/.test(line.trim())) {
        // asciiend may be followed by ] or other closing chars
        const after = line.trim().slice('asciiend'.length);
        out.push(indent + '<span class="keyword">asciiend</span>' + this._esc(after));
      } else {
        out.push(indent + '<span class="string">' + this._esc(line) + '</span>');
      }
    }
    return out.join('\n');
  }

  _renderLineAsTokens(code) {
    if (!code) return '';
    try {
      return this._renderTokens(this._parseLine(code).tokens);
    } catch(e) { return this._esc(code); }
  }

  _renderTokens(tokens) {
    return tokens.map(([type, value]) =>
      type === T.SPACE ? this._esc(value || ' ') : `<span class="${type}">${this._esc(value)}</span>`
    ).join('');
  }
  _warnSpan(text, msg, severity = 'error') {
    const cls = severity === 'warning' ? 'warning-w' : 'warning';
    return `<span class="${cls}" data-warning="${this._esc(msg)}">${this._esc(text)}</span>`;
  }
  _esc(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  // ── UTILITIES ─────────────────────────────────────────────
  _block(type, indent, raw, tokens, extra = {}) {
    return { type, indent, raw, tokens, def: null, name: null, value: null,
             children: [], warnings: [], ...extra };
  }
  _warn(type, message, severity = 'error') { return { type, message, severity }; }
  _warnW(type, message) { return this._warn(type, message, 'warning'); }
  _leadingSpaces(line) {
    let i = 0;
    while (i < line.length && line[i] === ' ') i++;
    return i;
  }
}

if (typeof module !== 'undefined') module.exports = { StonescriptParser, B, T, W };
