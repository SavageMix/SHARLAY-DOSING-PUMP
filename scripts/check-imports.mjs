import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import ts from 'typescript';

const require = createRequire(import.meta.url);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const MOBILE_DIR = path.resolve(__dirname, '../apps/mobile');
const ROOT_DIR = path.resolve(__dirname, '..');
const MODULE_PATHS = [
  path.join(MOBILE_DIR, 'node_modules'),
  path.join(ROOT_DIR, 'node_modules'),
];

const SOURCE_DIRS = ['app', 'components', 'constants', 'src'];

const TSCONFIG_PATH = path.join(MOBILE_DIR, 'tsconfig.json');
const tsConfig = ts.readConfigFile(TSCONFIG_PATH, ts.sys.readFile).config;
const parsedConfig = ts.parseJsonConfigFileContent(tsConfig, ts.sys, MOBILE_DIR);

const compilerHost = ts.createCompilerHost(parsedConfig.options);
const program = ts.createProgram([], parsedConfig.options, compilerHost);
const checker = program.getTypeChecker();

function resolvePathAlias(importPath, sourceFile) {
  if (!importPath.startsWith('@/')) return null;
  const relative = importPath.replace('@/', './');
  const candidate = path.resolve(MOBILE_DIR, relative);
  const extensions = ['', '.tsx', '.ts', '.jsx', '.js', '/index.tsx', '/index.ts', '/index.jsx', '/index.js'];
  for (const ext of extensions) {
    const full = candidate + ext;
    if (fs.existsSync(full) && fs.statSync(full).isFile()) return full;
  }
  return candidate;
}

function resolveNodeModule(importPath) {
  if (importPath.startsWith('.') || importPath.startsWith('@/')) return null;
  try {
    const resolved = require.resolve(importPath, { paths: MODULE_PATHS });
    return resolved;
  } catch {
    return null;
  }
}

function getExportedNames(filePath) {
  if (!fs.existsSync(filePath)) return null;
  const sourceText = fs.readFileSync(filePath, 'utf-8');
  const sourceFile = ts.createSourceFile(filePath, sourceText, ts.ScriptTarget.Latest, true);

  const exports = {
    default: false,
    named: new Set(),
  };

  function visit(node) {
    if (ts.isExportAssignment(node) && !node.isExportEquals) {
      exports.default = true;
    }
    if (ts.isExportDeclaration(node) && node.exportClause) {
      if (ts.isNamedExports(node.exportClause)) {
        for (const elem of node.exportClause.elements) {
          exports.named.add(elem.name.text);
        }
      } else if (ts.isNamespaceExport(node.exportClause)) {
        exports.default = true;
      }
    }
    if (
      (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node) ||
        ts.isTypeAliasDeclaration(node) || ts.isVariableStatement(node) || ts.isEnumDeclaration(node)) &&
      node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
    ) {
      if (ts.isVariableStatement(node)) {
        for (const decl of node.declarationList.declarations) {
          if (ts.isIdentifier(decl.name)) exports.named.add(decl.name.text);
        }
      } else if (node.name) {
        exports.named.add(node.name.text);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return exports;
}

function checkFile(filePath) {
  const sourceText = fs.readFileSync(filePath, 'utf-8');
  const sourceFile = ts.createSourceFile(filePath, sourceText, ts.ScriptTarget.Latest, true);
  const issues = [];

  for (const stmt of sourceFile.statements) {
    if (!ts.isImportDeclaration(stmt)) continue;
    const importPath = stmt.moduleSpecifier.text;
    if (importPath.endsWith('.json')) continue;
    const isTypeOnly = stmt.importClause?.isTypeOnly;
    if (isTypeOnly) continue;

    let resolved;
    if (importPath.startsWith('@/')) {
      resolved = resolvePathAlias(importPath, filePath);
    } else if (importPath.startsWith('.')) {
      const base = path.resolve(path.dirname(filePath), importPath);
      const extensions = ['', '.tsx', '.ts', '.jsx', '.js', '/index.tsx', '/index.ts', '/index.jsx', '/index.js'];
      resolved = base;
      for (const ext of extensions) {
        const full = base + ext;
        if (fs.existsSync(full) && fs.statSync(full).isFile()) {
          resolved = full;
          break;
        }
      }
    } else {
      resolved = resolveNodeModule(importPath);
    }

    const isLocal = importPath.startsWith('.') || importPath.startsWith('@/');
    if (!resolved) {
      if (isLocal) {
        issues.push({ importPath, reason: 'Could not resolve module' });
      }
      continue;
    }
    // We only statically verify local file exports. Node modules may be CJS/compiled
    // and runtime verification is better done by bundling/running the app.
    if (!isLocal) continue;

    if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
      resolved = path.join(resolved, 'index.js');
    }
    if (!resolved.endsWith('.js') && fs.existsSync(resolved + '.js')) {
      resolved += '.js';
    }

    const exports = getExportedNames(resolved);
    if (!exports) {
      issues.push({ importPath, reason: `Could not parse exports of ${resolved}` });
      continue;
    }

    const importClause = stmt.importClause;
    if (!importClause) continue;

    if (importClause.name) {
      // default import
      if (!exports.default) {
        issues.push({ importPath, name: importClause.name.text, reason: 'Default export not found' });
      }
    }

    if (importClause.namedBindings) {
      if (ts.isNamedImports(importClause.namedBindings)) {
        for (const elem of importClause.namedBindings.elements) {
          const importedName = elem.name.text;
          const propertyName = elem.propertyName?.text ?? importedName;
          if (!exports.named.has(propertyName)) {
            issues.push({ importPath, name: importedName, reason: `Named export '${propertyName}' not found` });
          }
        }
      }
      if (ts.isNamespaceImport(importClause.namedBindings)) {
        // namespace import is generally safe if module exists
      }
    }
  }

  return issues;
}

const files = [];
for (const dir of SOURCE_DIRS) {
  const fullDir = path.join(MOBILE_DIR, dir);
  if (!fs.existsSync(fullDir)) continue;
  const entries = fs.readdirSync(fullDir, { recursive: true });
  for (const entry of entries) {
    const fullPath = path.join(fullDir, entry);
    if (fs.statSync(fullPath).isFile() && /\.(ts|tsx)$/.test(fullPath)) {
      files.push(fullPath);
    }
  }
}

let totalIssues = 0;
for (const file of files) {
  const issues = checkFile(file);
  if (issues.length) {
    totalIssues += issues.length;
    console.log(`\n${path.relative(MOBILE_DIR, file)}`);
    for (const issue of issues) {
      console.log(`  - ${issue.name ? `${issue.name} from ` : ''}${issue.importPath}: ${issue.reason}`);
    }
  }
}

if (totalIssues === 0) {
  console.log('No import issues found.');
} else {
  console.log(`\nTotal issues: ${totalIssues}`);
  process.exit(1);
}
