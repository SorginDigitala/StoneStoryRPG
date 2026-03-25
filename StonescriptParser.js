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
  BAD_CONTINUE: 'invalid_continuation',
  BAD_ASCII:    'invalid_ascii',
  BAD_ARG_TYPE: 'invalid_arg_type',
  UNDECLARED_VAR: 'undeclared_variable',
};

const SCOPE_OPENERS = [B.CONDITION, B.ELSEIF, B.ELSE, B.FUNC_DEF, B.FOR_LOOP];
const TRIVIAL_TYPES = [B.EMPTY, B.CONTINUE, B.COMMENT];

// Characters never valid in a condition expression
const INVALID_EXPR_CHARS = /[;]/;

class StonescriptParser {
  constructor(api) {
    this.api        = api;
    this.byId       = {};
    this.byIdLower  = {};  // case-insensitive lookup: lowercase key → entry
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
    this.sealedGroupsLower       = new Set();
    this.reservedNames           = new Set();
    this.validAbilityIds         = new Set();
    this.continuationStartsWith  = new Set();
    this.keywordsNotInExpr       = new Set();
    this.nonAssignableRoots      = new Set();
    this.funcValidate            = {};
    this.argTypeRules            = {};
    this.argTypeCheckEnabled     = false;
    this.comparisonOps           = new Set(['=','!','<','>','<=','>=']);
    this.logicalOps              = new Set(['&','|']);
    this.literalArgFollows       = new Set(['search_string','ability_id','sound_id','hud_opts','ingredient_expr','script_path','print_args','string']);
    this.exitKeywords            = new Set(['return','break']);
    this.validConditionOps       = new Set(['=','!','&','|','>','<','>=','<=']);

    // Loaded from ?.validate
    this.condValidate = {};
    // Loaded from import.validate
    this.importValidate = {};
    // Loaded from var.validate
    this.varValidate = {};

    // FIX: Initialize _inlineArgWarnings to prevent contamination
    this._inlineArgWarnings = [];

    this._buildIndex();
  }

  _buildIndex() {
    const singleCmds = [];
    for (const e of this.api) {
      this.byId[e.id] = e;
      this.byIdLower[e.id.toLowerCase()] = e;
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
            this.sealedGroupsLower     = new Set((e.sealed_groups || []).map(s => s.toLowerCase()));
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
    // Add known module roots (battle, loop, ui, etc.) to varRoots so their
    // methods are not flagged as undeclared (data-driven from __validation__)
    if (this.byId['__validation__']) {
      const moduleRoots = this.byId['__validation__'].known_module_roots || [];
      for (const r of moduleRoots) {
        if (!this.varRoots.includes(r)) this.varRoots.push(r);
      }
    }
    // Load arg type rules from __validation__.arg_type_rules
    if (this.byId['__validation__']) {
      const m = this.byId['__validation__'];
      this.argTypeRules        = m.arg_type_rules        || {};
      this.argTypeCheckEnabled = m.arg_type_check_enabled || false;
      this.comparisonOps       = new Set(m.comparison_operators  || ['=','!','<','>','<=','>=']);
      this.logicalOps          = new Set(m.logical_operators      || ['&','|']);
      this.literalArgFollows   = new Set(m.literal_arg_follows    || []);
      this.exitKeywords        = new Set(m.exit_keywords           || ['return','break']);
    }
  }

  // ── PUBLIC API ────────────────────────────────────────────
  format(code) { return this.toHtml(this.parse(code)); }
  parse(code) {
    // FIX: Reset mutable state before each parse to prevent contamination
    this._inlineArgWarnings = [];

    const lines  = this._splitLines(code);
    // Track source line number for each split block
    // A split block may span multiple source lines (e.g. /* */ or ascii)
    let srcLine = 0;
    const flat = lines.map(l => {
      // FIX: Flush inline warnings between blocks to prevent contamination
      this._inlineArgWarnings = [];
      const b      = this._parseLine(l);
      b.lineNum    = srcLine;
      srcLine     += (l.match(/\n/g) || []).length + 1;
      return b;
    });
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
            if (/^(import|new)\s/.test(valPart.trim())) importRoots.add(name);
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
        // for loop variables — both 'for v = a..b' and 'for v : array'
        if (b.type === 'for_loop' && b.value) {
          const m = b.value.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*[=:]/);
          if (m) declared.add(m[1]);
        }
        collect(b.children);
      }
    })(blocks);

    // Pass B: walk all blocks and check identifier tokens in expressions
    const self = this;
    (function check(bs) {
      for (const b of bs) {
        self._checkBlockIdentifiers(b, declared, importRoots);
        check(b.children);
      }
    })(blocks);
  }

  _checkBlockIdentifiers(block, declared, importRoots) {
    if (!block.tokens) return;
    // If block already has unknown_command error, skip undeclared check — it's redundant
    if (block.warnings.some(w => w.type === W.UNKNOWN_CMD)) return;

    // Build a set of positions to skip (RHS of comparisons)
    const skipPositions = new Set();
    const COMPARISON_OPS = this.comparisonOps;
    const LOGICAL_OPS    = this.logicalOps;
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

    const isDefinition = block.type === B.FUNC_DEF || block.type === B.FOR_LOOP;
    const isImport = block.type === B.KEYWORD && block.name === 'import';
    const isVar = block.type === B.KEYWORD && block.name === 'var';
    const LITERAL_ARG_FOLLOWS = this.literalArgFollows;
    const isLiteralArgCmd = block.type === B.COMMAND && block.def &&
      LITERAL_ARG_FOLLOWS.has(block.def.follows);
    const isPrint = block.type === B.PRINT;

    let condHasOperator = false;
    if (block.type === B.CONDITION || block.type === B.ELSEIF) {
      condHasOperator = block.tokens.some(([t,v]) =>
        t === T.OPERATOR && this.comparisonOps.has(v));
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
      if (type !== T.IDENTIFIER) continue;
      if (skipPositions.has(i)) continue;
      if (isDefinition && i <= 2) continue;
      if (isImport) continue;
      if (isVar) continue;
      if (isPrint) continue;
      if (isLiteralArgCmd && i >= cmdArgStart) continue;
      // Method access after '.'
      {
        let prevMeaningful = null, prevPrev = null;
        for (let j = i - 1; j >= 0; j--) {
          if (block.tokens[j][0] === T.SPACE) continue;
          if (!prevMeaningful) { prevMeaningful = block.tokens[j]; continue; }
          prevPrev = block.tokens[j]; break;
        }
        if (prevMeaningful && prevMeaningful[0] === T.STRING && prevMeaningful[1] === '.') {
          if (prevPrev && prevPrev[0] === T.BRACKET && prevPrev[1] === ']') {
            const arrayMethod = 'array.' + value;
            if (this.byId[arrayMethod] || this._lookupFuncOrVar(arrayMethod)) continue;
          } else {
            continue; // variable/object method — skip (type unknown at parse time)
          }
        }
      }

      // Skip boolean literals
      if (value === 'true' || value === 'false') continue;
      if (/^[^a-zA-Z_]/.test(value)) continue;
      if (this.keywordSet.has(value.toLowerCase())) continue;
      if (this.varRoots.some(r => r.toLowerCase() === value.split('.')[0].toLowerCase())) continue;
      if (this.byIdLower[value.toLowerCase()]) continue;
      const def = this._lookupFuncOrVar(value);
      if (def) continue;
      const root = value.split('.')[0];
      if (importRoots.has(root)) continue;
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

  _flushInlineWarnings() {
    const w = this._inlineArgWarnings || [];
    this._inlineArgWarnings = [];
    return w;
  }

  // ── PASS 1A: LINE SPLITTING ───────────────────────────────
  _splitLines(code) {
    const lines = code.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
    const out = [];
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];

      // A multiline block /* ... */ starts only when:
      // 1. The line is not a // line comment
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
    // FIX: Reset inline warnings at the start of each line parse
    this._inlineArgWarnings = [];

    if (rawLine.includes('\n')) {
      const indent = this._indentWidth(rawLine);
      const content = rawLine.trimStart();
      if (this._isAsciiBlock(content)) {
        return this._parseAsciiBlock(indent, content);
      }
      return this._block(B.COMMENT, indent, content, [[T.COMMENT, content]]);
    }

    // FIX: Use _indentWidth for visual indent and trimStart() for content extraction.
    // Previously used rawLine.slice(indent) which breaks with tabs because
    // _leadingSpaces counts tabs as 2 chars but they are only 1 character.
    const indent  = this._indentWidth(rawLine);
    const content = rawLine.trimStart();

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
        ...(expr === '' ? [this._warn(W.EMPTY_EXPR, 'La condicion :? esta vacia.')] : []),
        ...this._checkConditionExpr(expr),
      ];
      const tokens = [[T.CONTROL, ':?'], ...this._tokenizeExpr(after)];
      return this._block(B.ELSEIF, indent, content, tokens, { name: ':?', value: expr, warnings });
    }

    // : else  — strict validation
    if (content[0] === ':') {
      const afterColon = content.slice(1);
      // Valid: ':' alone, '://', ':/*', ': //', ': /*'
      const trimmedAfter = afterColon.trimStart();
      if (trimmedAfter === '' || trimmedAfter.startsWith('//') || trimmedAfter.startsWith('/*')) {
        const tokens = [[T.CONTROL, ':']];
        if (afterColon) tokens.push([T.COMMENT, afterColon]);
        return this._block(B.ELSE, indent, content, tokens, { name: ':' });
      }
      // Invalid content after ':'
      const tokens   = [[T.CONTROL, ':'], ...this._tokenizeExpr(afterColon)];
      const warnings = [this._warn(W.BAD_EXPR,
        `Contenido inesperado tras ':'. Usa ':?' para elseif o ':' solo para else.`)];
      return this._block(B.ELSE, indent, content, tokens, { name: ':', warnings });
    }

    // ? condition
    if (content[0] === '?') {
      const after = content.slice(1), expr = after.trimStart();
      const warnings = [
        ...(expr === '' ? [this._warn(W.EMPTY_EXPR, 'La condicion ? esta vacia.')] : []),
        ...this._checkConditionExpr(expr),
      ];
      const tokens = [[T.CONTROL, '?'], ...this._tokenizeExpr(after)];
      return this._block(B.CONDITION, indent, content, tokens, { name: '?', value: expr, warnings });
    }

    // Print prefixes (longest first)
    // >f, >o, >h, >c only match as print commands if followed by a digit, minus
    // (coordinate) or nothing — NOT by a letter (e.g. >found is "> found" not ">f ound")
    for (const pfx of this.printPfx) {
      if (content.startsWith(pfx)) {
        const afterPfx = content[pfx.length] || '';
        // Multi-char prefixes like >o, >f, >h, >c need coord-like content after them
        if (pfx.length > 1 && pfx !== '>(' && pfx !== '>`' && /[a-zA-Z_]/.test(afterPfx)) {
          continue; // Not a print command — e.g. >found, >okay, >hello
        }
        const arg = content.slice(pfx.length);
        const tokens = [[T.PRINT, pfx]];
        if (arg) tokens.push([T.STRING, arg]);
        return this._block(B.PRINT, indent, content, tokens, { name: pfx, value: arg });
      }
    }

    // Multi-word commands (longest first)
    for (const cmd of this.multiCmds) {
      const lcLine = content.toLowerCase();
      if (lcLine.startsWith(cmd.toLowerCase())) {
        const afterCmd = content.slice(cmd.length);
        if (afterCmd === '' || /^\s/.test(afterCmd)) {
          const arg    = afterCmd.trimStart();
          const def    = this.byId[cmd] || null;
          const warnings = [...this._checkFollow(def, arg), ...this._checkCommand(cmd.toLowerCase(), arg, def)];
          const tokens   = [[T.COMMAND, content.slice(0, cmd.length)]];
          if (arg !== '') {
            const spaces = afterCmd.slice(0, afterCmd.length - afterCmd.trimStart().length);
            tokens.push([T.SPACE, spaces || ' ']);
            tokens.push(...this._tokenizeArg(arg, def));
          }
          return this._block(B.COMMAND, indent, content, tokens, { name: cmd, value: arg, def, warnings });
        }
      }
    }

    // Word-based parsing (keywords, single commands, func calls, assignments)
    if (/^[a-zA-Z_]/.test(content)) return this._parseWordLine(indent, content);

    // Fallback: raw
    const tokens   = this._tokenizeExpr(content);
    const warnings = this._flushInlineWarnings();
    return this._block(B.RAW, indent, content, tokens, { warnings });
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
      const warnings = [...this._checkAssignment(word), ...this._checkAssignValue(rest)];
      return this._block(B.ASSIGN, indent, content, tokens, { name: word, value: rest.trim(), warnings });
    }

    // Bare word: Rule 3 (bad statement) + Rule 7 (sealed prop)
    const warnings = this._checkBareWord(word, rest);
    const tokens   = [...this._resolveIdentToken(word), ...this._tokenizeExpr(rest)];
    // FIX: Flush inline warnings for bare word/raw blocks
    warnings.push(...this._flushInlineWarnings());
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
      ...this._flushInlineWarnings(),
    ];
    return this._block(B.CALL, indent, content, tokens, { name, value: rest, def, warnings });
  }

  // Detect junk after a function call: test() aoeu
  // In conditions, operators like = > < after ) are valid (comparison).
  // In standalone calls, = after ) means trying to assign to a call result — error.
  _checkCallTrailingJunk(callStr, isCondition = false) {
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
    // Math operators are always OK (e.g. fc() + 1)
    if (/^[+\-*\/%]/.test(after)) return [];
    // Comparison/logical operators only OK inside conditions
    if (isCondition && /^[=!<>&|]/.test(after)) return [];
    // Standalone: = after call is assignment to call result — error
    if (/^[=]/.test(after)) {
      return [this._warn(W.BAD_EXPR,
        `No se puede asignar al resultado de una llamada a funcion.`)];
    }
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
    // FIX: Check for dangling & or | at end of conditions/elseifs
    // Only error if the NEXT non-trivial block is NOT a ^ continuation
    for (let bi = 0; bi < n; bi++) {
      const b = blocks[bi];
      if (b.type !== B.CONDITION && b.type !== B.ELSEIF) continue;
      if (!b.value) continue;
      // Check if expression ends with & or |
      const exprTokens = this._tokenizeExpr(b.value);
      let lastOp = null;
      for (const [t, v] of exprTokens) {
        if (t === 'space' || t === 'comment') continue;
        if (t === 'operator' && this.logicalOps.has(v)) lastOp = v;
        else lastOp = null;
      }
      if (!lastOp) continue;
      // Look ahead: is the next block a ^ continuation?
      let hasContinuation = false;
      for (let j = bi + 1; j < n; j++) {
        if (blocks[j].type === B.EMPTY || blocks[j].type === B.COMMENT) continue;
        if (blocks[j].type === B.CONTINUE) hasContinuation = true;
        break;
      }
      if (!hasContinuation) {
        b.warnings.push(this._warn(W.BAD_EXPR,
          `La condicion termina con '${lastOp}' sin operando derecho. ` +
          `Añade una condicion tras '${lastOp}' o usa ^ para continuar en la siguiente linea.`));
      }
    }

    // FIX: Check for unclosed brackets in var/assign blocks.
    // Concatenate the block's raw content with all following ^ continuation blocks.
    // If brackets are still unclosed after all continuations, it's an error.
    for (let bi = 0; bi < n; bi++) {
      const b = blocks[bi];
      if (b.type !== B.KEYWORD && b.type !== B.ASSIGN) continue;
      if (b.type === B.KEYWORD && b.name !== 'var') continue;
      // Gather all raw content: this block + following ^ continuations + trailing ] or )
      let fullExpr = b.raw || '';
      for (let j = bi + 1; j < n; j++) {
        if (blocks[j].type === B.EMPTY || blocks[j].type === B.COMMENT) continue;
        if (blocks[j].type === B.CONTINUE) {
          fullExpr += '\n' + (blocks[j].raw || '');
          continue;
        }
        // A raw block that is just ] or ) closes the bracket — include it
        const rawTr = (blocks[j].raw || '').trim();
        if (blocks[j].type === B.RAW && /^[\]\)]+$/.test(rawTr)) {
          fullExpr += '\n' + (blocks[j].raw || '');
          continue;
        }
        break; // non-continuation block — stop
      }
      // Count bracket depth across the full expression, skipping string contents
      let bracketDepth = 0, parenDepth = 0;
      let inStr = false, strCh = '';
      for (let ci = 0; ci < fullExpr.length; ci++) {
        const ch = fullExpr[ci];
        if (inStr) {
          if (ch === strCh) inStr = false;
          continue;
        }
        if (ch === '"' || ch === "'") { inStr = true; strCh = ch; continue; }
        if (ch === '[') bracketDepth++;
        else if (ch === ']') bracketDepth--;
        else if (ch === '(') parenDepth++;
        else if (ch === ')') parenDepth--;
      }
      if (bracketDepth > 0) {
        b.warnings.push(this._warn(W.BAD_VAR,
          `Corchete '[' sin cerrar. Falta ']' al final de la expresion.`));
      }
      if (parenDepth > 0) {
        b.warnings.push(this._warn(W.BAD_EXPR,
          `Parentesis '(' sin cerrar. Falta ')' al final de la expresion.`));
      }
    }

    // FIX: Check for junk in ^ continuation lines of var/assign blocks.
    // Concatenate all ^ lines and run junk detection on the combined value.
    for (let bi = 0; bi < n; bi++) {
      const b = blocks[bi];
      if (b.type !== B.KEYWORD && b.type !== B.ASSIGN) continue;
      if (b.type === B.KEYWORD && b.name !== 'var') continue;
      // Get the value portion
      let valExpr = '';
      if (b.type === B.KEYWORD && b.name === 'var' && b.value) {
        const eqIdx = b.value.indexOf('=');
        valExpr = eqIdx >= 0 ? b.value.slice(eqIdx + 1).trim() : '';
      } else if (b.type === B.ASSIGN && b.value) {
        const m = b.value.match(/^[+\-*\/]?=\s*(.*)/s);
        valExpr = m ? m[1] : '';
      }
      // Append ^ continuation content and trailing ] blocks
      for (let j = bi + 1; j < n; j++) {
        if (blocks[j].type === B.EMPTY || blocks[j].type === B.COMMENT) continue;
        if (blocks[j].type === B.CONTINUE) {
          const contContent = (blocks[j].raw || '').replace(/^\^/, '').trim();
          valExpr += ' ' + contContent;
          continue;
        }
        const rawTr = (blocks[j].raw || '').trim();
        if (blocks[j].type === B.RAW && /^[\]\)]+$/.test(rawTr)) {
          valExpr += ' ' + rawTr;
          continue;
        }
        break;
      }
      if (!valExpr.trim()) continue;
      // Run junk detection on the full combined value
      const junkWarn = this._detectValueJunk(valExpr);
      if (junkWarn && !b.warnings.some(w => w.type === junkWarn.type)) {
        b.warnings.push(junkWarn);
      }
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
        // 'import' or 'new' in an expression (e.g. var x = import Path, array element)
        // → keyword (blue) + path as STRING token (so scope analysis skips it)
        if (word.toLowerCase() === 'import' || word.toLowerCase() === 'new') {
          tokens.push([T.KEYWORD, word]);
          // Consume optional whitespace then the path (letters, digits, _, ., -, /)
          let pathStart = pos;
          while (pos < expr.length && (expr[pos] === ' ' || expr[pos] === '\t')) pos++;
          if (pathStart < pos) tokens.push([T.SPACE, expr.slice(pathStart, pos)]);
          const pathMatch = expr.slice(pos).match(/^[a-zA-Z0-9_.\-]+(?:\/[a-zA-Z0-9_.\-]+)*/);
          if (pathMatch) {
            tokens.push([T.STRING, pathMatch[0]]);
            pos += pathMatch[0].length;
          }
          continue;
        }
        if (pos < expr.length && expr[pos] === '(') {
          // Try direct lookup, then 'array.X' if previous meaningful token was ']'.'
          let def = this._lookupFuncOrVar(word);
          if (!def) {
            const lastTok = tokens.length ? tokens[tokens.length - 1] : null;
            const prevTok = tokens.length > 1 ? tokens[tokens.length - 2] : null;
            if (lastTok && lastTok[0] === T.STRING && lastTok[1] === '.' &&
                prevTok && prevTok[0] === T.BRACKET && prevTok[1] === ']') {
              def = this._lookupFuncOrVar('array.' + word);
            }
          }
          tokens.push([(def && def.type === 'func') ? T.FUNCTION : T.IDENTIFIER, word]);
          let depth = 1, inner = '('; pos++;
          while (pos < expr.length && depth > 0) {
            const ch = expr[pos]; inner += ch;
            if (ch === '(') depth++; else if (ch === ')') depth--;
            pos++;
          }
          tokens.push(...this._tokenizeCallArgs(inner, def));
          // Arg count + type check inline
          if (def && def.args && !def.overloads) {
            if (!this._inlineArgWarnings) this._inlineArgWarnings = [];
            const callStr = '(' + inner.slice(1);
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
    // FIX: Only add ')' if paren was actually closed in the source
    if (depth === 0) tokens.push([T.PAREN, ')']);
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
    const root = word.split('.')[0].toLowerCase();
    if (this.varRoots.some(r => r.toLowerCase() === root)) return [[T.VARIABLE, word]];
    return [[T.IDENTIFIER, word]];
  }
  _lookupFuncOrVar(name) {
    // Case-insensitive lookup: Stonescript names are not case-sensitive
    const lc = name.toLowerCase();
    if (this.byIdLower[lc]) return this.byIdLower[lc];
    const bare = lc.replace(/\(.*$/s, '');
    if (this.byIdLower[bare]) return this.byIdLower[bare];
    return null;
  }
  _lookupCommand(name) {
    const lc = name.toLowerCase();
    return this.api.find(e => e.type === 'command' && e.id.toLowerCase() === lc) || null;
  }

  // ── VALIDATION (data-driven) ──────────────────────────────

  _checkConditionExpr(expr) {
    if (!expr) return [];
    const warns = [];
    // FIX: Reset inline warnings before tokenizing
    this._inlineArgWarnings = [];

    if (INVALID_EXPR_CHARS.test(expr))
      warns.push(this._warn(W.BAD_EXPR,
        `Caracter invalido en la expresion: '${expr.match(INVALID_EXPR_CHARS)[0]}'. ` +
        `Las condiciones no admiten ';'. Usa '&' para combinar condiciones.`));

    const doubleOps = expr.match(/[=!<>]{2,}/g);
    if (doubleOps) {
      for (const seq of doubleOps) {
        if (!this.validConditionOps.has(seq))
          warns.push(this._warn(W.BAD_OPERATOR,
            `Operador invalido: '${seq}'. Operadores validos: = ! < > <= >= & |`));
      }
    }

    if (this.condValidate.no_embedded_condition && expr.includes('?'))
      warns.push(this._warn(W.BAD_EXPR,
        `'?' no puede aparecer dentro de una expresion de condicion.`));

    if (this.condValidate.no_keywords_as_operands && this.keywordsNotInExpr.size) {
      const words = expr.match(/\b[a-zA-Z_][a-zA-Z0-9_]*\b/g) || [];
      for (const w of words) {
        if (this.keywordsNotInExpr.has(w.toLowerCase()))
          warns.push(this._warn(W.BAD_EXPR,
            `'${w}' es una palabra reservada y no puede usarse como operando en una condicion.`));
      }
    }

    // no_bare_string: only flag UNQUOTED bare words (e.g. ?foe skeleton)
    // Quoted strings like ?foe "skeleton" are valid — the intent is clear.
    // Unquoted multi-word is already caught by _checkCondTrailingJunk.

    // FIX: Sealed property check should skip dotted words in the RHS of comparisons.
    // After '=' or '!', everything until the next '&' or '|' is a string value.
    // e.g. ?foe.time=foe.totaltime → 'foe.totaltime' is the RHS string, not a property access.
    const dottedWords = expr.match(/\b[a-zA-Z_][a-zA-Z0-9_.]*\b/g) || [];
    if (dottedWords.length) {
      // Build a set of RHS regions to skip
      const rhsWords = new Set();
      const tokens = this._tokenizeExpr(expr);
      let inRHS = false;
      for (const [type, value] of tokens) {
        if (type === 'space' || type === 'comment') continue;
        if (type === 'operator' && this.comparisonOps.has(value)) { inRHS = true; continue; }
        if (type === 'operator' && this.logicalOps.has(value)) { inRHS = false; continue; }
        if (inRHS && (type === 'identifier' || type === 'variable')) {
          rhsWords.add(value);
        }
      }
      for (const dw of dottedWords) {
        if (!dw.includes('.')) continue;
        if (rhsWords.has(dw)) continue; // Skip: this word is in a RHS string context
        warns.push(...this._checkSealedProp(dw));
      }
    }

    warns.push(...this._checkCondTrailingJunk(expr));

    // FIX: Always flush inline warnings after condition check
    warns.push(...this._flushInlineWarnings());

    return warns;
  }

  // FIX: ^ just means "this line continues the previous one".
  // Any content is valid after ^. Only error if completely empty.
  _checkContinuation(rest) {
    if (!rest) return [this._warn(W.BAD_CONTINUE,
      `La linea de continuacion ^ esta vacia.`)];
    return [];
  }

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

  _checkSealedProp(name) {
    if (!name.includes('.')) return [];
    const root = name.split('.')[0].toLowerCase();
    if (!this.sealedGroupsLower.has(root)) return [];
    // Case-insensitive lookup
    const lc = name.toLowerCase();
    if (this.byIdLower[lc]) return [];
    const bare = lc.replace(/\(.*$/s, '');
    if (this.byIdLower[bare]) return [];
    return [this._warn(W.SEALED_PROP,
      `'${name}' no existe. '${root}' es una variable nativa sellada — ` +
      `sus propiedades estan fijadas por el juego.`)];
  }

  _checkImport(path) {
    const commentIdx = path.indexOf('//');
    const stripped   = (commentIdx >= 0 ? path.slice(0, commentIdx) : path).trim();
    // FIX: Empty path is an error
    if (!stripped) return [this._warn(W.BAD_IMPORT, `Se requiere una ruta de archivo.`)];
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

  _checkVarDecl(arg) {
    const trimmed = arg.trim();
    // FIX: Empty var declaration is an error
    if (!trimmed) return [this._warn(W.BAD_VAR, `Se requiere un nombre de variable.`)];

    const eqIdx  = trimmed.indexOf('=');
    const namePart = (eqIdx >= 0 ? trimmed.slice(0, eqIdx) : trimmed).trim();
    const valPart  = eqIdx >= 0 ? trimmed.slice(eqIdx + 1).trim() : '';

    if (/,/.test(namePart))
      return [this._warn(W.BAD_VAR,
        `Solo se puede declarar una variable a la vez. Usa una linea 'var' por variable.`)];

    if (/\s/.test(namePart))
      return [this._warn(W.BAD_VAR,
        `Solo se puede declarar una variable a la vez. Usa una linea 'var' por variable.`)];

    const name = namePart;
    const pattern = this.varValidate.identifier_pattern || '^[a-zA-Z_][a-zA-Z0-9_]*$';
    if (!new RegExp(pattern).test(name))
      return [this._warn(W.BAD_VAR,
        `'${name}' no es un nombre de variable valido. ` +
        `Debe empezar por letra o _ y solo contener letras a-z A-Z, digitos 0-9 y _.`)];

    if (this.reservedNames.has(name))
      return [this._warn(W.BAD_VAR,
        `'${name}' es una variable nativa del juego y no puede usarse como nombre de variable.`)];

    // FIX: Also block language keywords as variable names
    if (this.keywordSet.has(name.toLowerCase()))
      return [this._warn(W.BAD_VAR,
        `'${name}' es una palabra reservada del lenguaje y no puede usarse como nombre de variable.`)];

    // FIX: Handle both 'var x = import path' and 'var x = new path'
    // Both create opaque references — validate only the path.
    if (valPart) {
      const importOrNew = valPart.trim().match(/^(import|new)\s+(.*)/);
      if (importOrNew) {
        return this._checkImport(importOrNew[2]);
      }
    }

    // FIX: Validate var values — detect invalid mixed types.
    // Rules:
    //   var x = aoeu aoeu       → valid (implicit multi-word string)
    //   var x = "aeuo" aeu      → error (quoted string + bare word)
    //   var x = 2 aoeu          → error (number + bare word)
    //   var x = [...]           → valid (array) — but unclosed [ is error
    if (this.varValidate.no_junk_after_value && valPart) {
      const junkWarn = this._detectValueJunk(valPart);
      if (junkWarn) return [junkWarn];
    }

    return [];
  }

  // Detect invalid mixed types in a value expression.
  // Rules:
  //   identifier identifier  → valid (implicit multi-word string: Hello World)
  //   "string" + identifier  → valid (+ is concatenation)
  //   "string" - identifier  → error (- is not concatenation)
  //   "string" = identifier  → error (= makes no sense in value)
  //   keyword as value       → error (var x = var)
  //   identifier "string"    → error (missing comma)
  //   identifier number      → error (missing comma)
  // Inside arrays the same rules apply between commas.
  _detectValueJunk(val) {
    const tokens = this._tokenizeExpr(val);
    let depth = 0;
    let lastType = null;
    let lastValue = null;
    let seenLiteral = false;
    let lastOperator = null;

    for (const [type, value] of tokens) {
      if (type === 'space' || type === 'comment') continue;
      if (type === 'paren' && value === '(')   { depth++; lastType = null; continue; }
      if (type === 'paren' && value === ')')   { depth = Math.max(0, depth - 1); lastType = 'paren'; continue; }
      if (type === 'bracket' && value === '[') { depth++; lastType = null; seenLiteral = false; continue; }
      if (type === 'bracket' && value === ']') { depth = Math.max(0, depth - 1); lastType = 'bracket'; seenLiteral = false; continue; }

      // Commas reset the segment context
      if (type === 'string' && value === ',') {
        lastType = 'comma'; lastValue = value; seenLiteral = false; lastOperator = null; continue;
      }

      // Track operators (for + concatenation check)
      if (type === 'operator') {
        lastType = 'operator'; lastValue = value; lastOperator = value; continue;
      }

      // Detect keywords used as values (var x = var, var x = return, etc.)
      // Check the value string against keywordSet regardless of token type,
      // because keywords may tokenize as T.VARIABLE or T.IDENTIFIER
      if (depth === 0 && this.keywordSet.has((value || '').toLowerCase()) &&
          !['import', 'new'].includes((value || '').toLowerCase())) {
        return this._warn(W.BAD_EXPR,
          `'${value}' es una palabra reservada del lenguaje y no puede usarse como valor.`);
      }

      // Track if we've seen a literal in this segment
      if (type === 'string' && /^["']/.test(value)) seenLiteral = true;
      if (type === 'number') seenLiteral = true;

      // After seeing a literal: bare identifiers are junk UNLESS preceded by +
      // (+ is string concatenation in Stonescript)
      if (seenLiteral && (type === 'identifier' || type === 'variable')) {
        if (lastOperator === '+') {
          lastType = type; lastValue = value; lastOperator = null; continue;
        }
        // Known native vars/funcs in expressions are OK (e.g. 1 * foe.hp)
        const lcVal = (value || '').toLowerCase();
        const isKnown = this.byIdLower[lcVal] || this._lookupFuncOrVar(value) ||
                         this.varRoots.some(r => r.toLowerCase() === lcVal.split('.')[0]);
        if (!isKnown) {
          return this._warn(W.BAD_EXPR,
            `Token inesperado: '${value}'. ` +
            `No se pueden mezclar literales con palabras sin comillas.`);
        }
      }

      // After a quoted string: another quoted string without comma is junk
      if (type === 'string' && /^["']/.test(value) && lastType === 'string') {
        return this._warn(W.BAD_EXPR,
          `String literal ${value} inesperado tras otro string. ` +
          `Falta una coma entre los valores.`);
      }

      // After an identifier: a quoted string or number without operator/comma is junk
      if (lastType === 'identifier' || lastType === 'variable') {
        if (type === 'string' && /^["']/.test(value)) {
          return this._warn(W.BAD_EXPR,
            `String literal ${value} inesperado tras '${lastValue}'. ` +
            `Falta una coma o un operador.`);
        }
        if (type === 'number') {
          return this._warn(W.BAD_EXPR,
            `Numero '${value}' inesperado tras '${lastValue}'. ` +
            `Falta una coma o un operador.`);
        }
      }

      lastType = type;
      lastValue = value;
      lastOperator = null;
    }

    return null;
  }

  _checkActivate(arg) {
    if (!arg.trim()) return [];
    const val = arg.trim();
    const lc  = val.toLowerCase();
    if (/\s/.test(val))
      return [this._warn(W.BAD_ACTIVATE,
        `'${val}' no puede contener espacios. ` +
        `Fijos validos: ${[...this.abilityFixed].join(', ')}.`)];
    if (!this.abilityCharset.test(val))
      return [this._warn(W.BAD_ACTIVATE,
        `'${val}' contiene caracteres no validos. ` +
        `Solo se permiten letras a-z A-Z, digitos y _.`)];
    if (this.abilityFixed.has(lc)) return [];
    if (this.abilityKnown.has(lc)) return [];
    return [this._warn(W.BAD_ACTIVATE,
      `'${val}' no es un ability ID reconocido. ` +
      `Fijos: ${[...this.abilityFixed].join(', ')}. ` +
      `Conocidos: ${[...this.abilityKnown].join(', ')}.`)];
  }

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

  _checkAssignment(name) {
    const root = name.split('.')[0];
    if (this.nonAssignableRoots.has(root))
      return [this._warn(W.BAD_STATEMENT,
        `'${name}' es una variable nativa y no puede ser asignada.`)];
    const sealedWarns = this._checkSealedProp(name);
    if (sealedWarns.length) return sealedWarns;
    return [];
  }

  // Called from _parseWordLine for ASSIGN blocks to validate the RHS value
  _checkAssignValue(rest) {
    // rest is like " = value" or " += value" — extract the value part
    const m = rest.match(/^\s*[+\-*\/]?=\s*(.*)/s);
    if (!m) return [];
    const valPart = m[1].trim();
    if (!valPart) return [];
    // Apply the same junk detection as var values
    const junkWarn = this._detectValueJunk(valPart);
    if (junkWarn) return [junkWarn];
    return [];
  }

  _checkCondTrailingJunk(expr) {
    if (!expr || !this.condValidate.no_trailing_junk) return [];
    const tokens = this._tokenizeExpr(expr);
    let lastMeaningful = null;
    let depth    = 0;
    let inRHS    = false;   // after a comparison op, consuming the RHS value
    let rhsHasValue = false; // whether we've seen at least one value token in RHS
    const COMPARISON_OPS = this.comparisonOps;
    const LOGICAL_OPS    = this.logicalOps;
    let lastOperator = null;

    for (const [type, value] of tokens) {
      if (type === 'space' || type === 'comment') continue;
      if (type === 'paren') {
        if (value === '(') { depth++; lastMeaningful = null; }
        else { depth = Math.max(0, depth - 1); if (depth === 0) lastMeaningful = 'paren'; }
        lastOperator = null;
        continue;
      }
      if (type === 'bracket') {
        if (value === '[') { depth++; lastMeaningful = null; }
        else { depth = Math.max(0, depth - 1); if (depth === 0) lastMeaningful = 'bracket'; }
        lastOperator = null;
        continue;
      }
      if (depth > 0) continue;

      // Logical operators reset RHS context — this is the correct separator
      if (type === 'operator' && LOGICAL_OPS.has(value)) {
        inRHS = false; rhsHasValue = false;
        lastMeaningful = 'operator'; lastOperator = value;
        continue;
      }

      // FIX: Comparison op while already in RHS = double comparison without & or |
      // e.g. ?foe = boss = aeou → two comparisons not separated by & or |
      if (type === 'operator' && COMPARISON_OPS.has(value)) {
        if (inRHS && rhsHasValue) {
          return [this._warn(W.BAD_EXPR,
            `Doble comparacion: '${value}' aparece tras un valor de comparacion. ` +
            `Usa '&' o '|' para separar condiciones.`)];
        }
        inRHS = true; rhsHasValue = false;
        lastMeaningful = 'operator'; lastOperator = value;
        continue;
      }

      // Inside RHS — consuming the value after a comparison operator
      if (inRHS) {
        rhsHasValue = true;
        lastOperator = null;
        continue;
      }

      // LHS context — check for junk
      if (type === 'string' && value === '.') { lastMeaningful = null; lastOperator = null; continue; }

      // Identifier/variable after a string literal = junk
      if ((type === 'identifier' || type === 'variable') && lastMeaningful === 'string') {
        return [this._warn(W.BAD_EXPR,
          `Token inesperado en la condicion: '${value}'. ` +
          `Falta un operador (= ! < > <= >= & |) antes de este valor.`)];
      }

      // Two consecutive value tokens without operator = junk
      if ((type === 'identifier' || type === 'variable') &&
          lastMeaningful &&
          ['identifier','variable','number','paren','bracket'].includes(lastMeaningful)) {
        return [this._warn(W.BAD_EXPR,
          `Token inesperado en la condicion: '${value}'. ` +
          `Falta un operador (= ! < > <= >= & |) antes de este valor.`)];
      }
      lastMeaningful = type;
      lastOperator = null;
    }

    // Note: dangling & or | at end is checked in _buildTree (needs ^ context)

    return [];
  }

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

  _checkFollow(def, arg) {
    if (!def || !def.follows) return [];
    if (arg.trim() !== '') return [];
    const args     = def.args || [];
    const required = args.length === 0 ? 1 : args.filter(a => !a.optional).length;
    if (!required) return [];
    return [this._warn(W.BAD_FOLLOW, `'${def.id}' requiere un argumento (${def.follows})`)];
  }

  _checkArgTypes(def, callStr) {
    if (!this.argTypeCheckEnabled || !def.args) return [];
    const m = callStr.trim().match(/^\((.*?)\)$/s);
    if (!m) return [];
    const inner = m[1].trim();
    if (!inner) return [];

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

      const tokenType = this._classifyArgValue(argVal);
      if (!tokenType) continue;
      if (tokenType === 'variable') continue;

      const rules = this.argTypeRules[argDef.type];
      if (!rules) continue;

      const validTokens = rules.valid_tokens || [];
      if (!validTokens.includes(tokenType)) {
        if (argDef.type === 'bool' && tokenType === 'bool') continue;
        if (['number','int','float'].includes(argDef.type) && tokenType === 'number') continue;
        warns.push(this._warn(W.BAD_ARG_TYPE,
          `Argumento '${argDef.name}' de '${def.id}': se esperaba ${argDef.type}, ` +
          `se recibio ${tokenType} ('${argVal.slice(0,20)}')`));
      }
    }
    return warns;
  }

  _classifyArgValue(val) {
    const v = val.trim();
    if (!v) return null;
    if (/^".*"$/.test(v) || /^'.*'$/.test(v)) return 'string';
    if (/^-?\d+(\.\d+)?$/.test(v)) return 'number';
    if (v === 'true' || v === 'false') return 'bool';
    if (/^[a-zA-Z_][a-zA-Z0-9_.]*$/.test(v)) return 'variable';
    return null;
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
        const m = line.match(/^(\s*)(.*?)(\s+)(ascii)(\s*)$/);
        if (m) {
          const pre = m[2] ? this._renderLineAsTokens(m[2]) + this._esc(m[3]) : this._esc(m[3]);
          out.push(indent + warns + pre + '<span class="keyword">ascii</span>');
        } else {
          out.push(indent + warns + '<span class="keyword">ascii</span>');
        }
      } else if (/^asciiend/.test(line.trim())) {
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

  // FIX: _indentWidth returns the VISUAL width (tabs=2) for indentation level.
  // Content extraction now uses trimStart() to avoid the tab/slice mismatch.
  _indentWidth(line) {
    let count = 0;
    for (let i = 0; i < line.length; i++) {
      if (line[i] === ' ')  { count++; }
      else if (line[i] === '\t') { count += 2; }
      else break;
    }
    return count;
  }

  // LEGACY alias — kept for backward compat if anything external uses it
  _leadingSpaces(line) {
    return this._indentWidth(line);
  }
}

if (typeof module !== 'undefined') module.exports = { StonescriptParser, B, T, W };
