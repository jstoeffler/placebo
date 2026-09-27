// Dependency rules from docs/brief.md §14, enforced by `pnpm depcruise` (part of `pnpm check`).
// Layers inside packages/core/src: kernel <- domain <- ports / statistics <- graders <- commands.
// adapters implement ports and never reach into commands, graders or statistics.

const CORE = '^packages/core/src/';
const layer = (name) => `${CORE}${name}/`;
const ZOD = '(^|/)node_modules/zod/';
const YAML = '(^|/)node_modules/yaml/';
/** Tests and test support may also use vitest and src/testing; layer rules apply to production code. */
const TESTS = ['\\.test\\.tsx?$', `${CORE}testing/`];

/** A rule that forbids everything from `from` except the listed targets. */
function only(name, from, allowed, comment) {
  return {
    name,
    comment,
    severity: 'error',
    from: { path: from, pathNot: TESTS },
    to: { pathNot: allowed },
  };
}

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'production-code-does-not-import-tests',
      comment: 'Only tests import test files, src/testing and vitest.',
      severity: 'error',
      from: { path: '^packages/[^/]+/src/', pathNot: TESTS },
      to: { path: [...TESTS, '(^|/)node_modules/(vitest|@vitest)/'] },
    },
    {
      name: 'no-circular',
      comment: 'No cycles anywhere.',
      severity: 'error',
      from: {},
      to: { circular: true },
    },
    {
      name: 'not-to-unresolvable',
      comment: 'Every import must resolve.',
      severity: 'error',
      from: {},
      to: { couldNotResolve: true },
    },
    {
      name: 'kernel-imports-builtins-and-zod-only',
      comment: 'core/kernel imports only node builtins and zod.',
      severity: 'error',
      from: { path: layer('kernel'), pathNot: TESTS },
      to: { pathNot: [layer('kernel'), ZOD], dependencyTypesNot: ['core'] },
    },
    only(
      'domain-imports-kernel-only',
      layer('domain'),
      [layer('domain'), layer('kernel'), ZOD, YAML],
      'core/domain imports only kernel, zod, and yaml (for parseSuite).',
    ),
    only(
      'ports-import-domain-and-kernel-only',
      layer('ports'),
      [layer('ports'), layer('domain'), layer('kernel')],
      'core/ports imports only domain and kernel.',
    ),
    only(
      'statistics-imports-domain-and-kernel-only',
      layer('statistics'),
      [layer('statistics'), layer('domain'), layer('kernel')],
      'core/statistics imports only domain and kernel.',
    ),
    only(
      'graders-import-domain-ports-kernel-only',
      layer('graders'),
      [layer('graders'), layer('domain'), layer('ports'), layer('kernel')],
      'core/graders imports only domain, ports and kernel.',
    ),
    only(
      'commands-import-no-adapters',
      layer('commands'),
      [
        layer('commands'),
        layer('domain'),
        layer('ports'),
        layer('graders'),
        layer('statistics'),
        layer('kernel'),
      ],
      'core/commands imports domain, ports, graders, statistics and kernel; never adapters.',
    ),
    {
      name: 'adapters-never-import-commands',
      comment:
        'core/adapters/* implement ports; they never import commands, graders or statistics.',
      severity: 'error',
      from: { path: layer('adapters') },
      to: { path: `${CORE}(commands|graders|statistics)/` },
    },
    {
      name: 'adapters-do-not-import-each-other',
      comment: 'Each adapter stands alone behind its port.',
      severity: 'error',
      from: { path: `${CORE}adapters/([^/]+)/` },
      to: { path: `${CORE}adapters/`, pathNot: `${CORE}adapters/$1/` },
    },
    {
      name: 'core-is-framework-free',
      comment: 'core never imports the Agent SDK, SQLite or React.',
      severity: 'error',
      from: { path: '^packages/core/' },
      to: {
        path: [
          '@anthropic-ai/claude-agent-sdk',
          '^(node:)?sqlite$',
          '(^|/)node_modules/react(-dom)?/',
        ],
      },
    },
    {
      name: 'core-does-not-import-apps',
      comment: 'core never imports cli or report.',
      severity: 'error',
      from: { path: '^packages/core/' },
      to: { path: '^packages/(cli|report)/' },
    },
    {
      name: 'cli-uses-core-public-entry-points',
      comment: 'cli imports core only through @placebo-eval/core and @placebo-eval/core/results.',
      severity: 'error',
      from: { path: '^packages/cli/' },
      to: { path: CORE, pathNot: `${CORE}(index|results)\\.ts$` },
    },
    {
      name: 'cli-does-not-import-report-code',
      comment: 'cli ships the built report.html as an asset; it never imports report code.',
      severity: 'error',
      from: { path: '^packages/cli/' },
      to: { path: '^packages/report/' },
    },
    {
      name: 'report-imports-results-contract-only',
      comment: 'report imports only @placebo-eval/core/results from the workspace.',
      severity: 'error',
      from: { path: '^packages/report/' },
      to: { path: '^packages/(core|cli)/', pathNot: `${CORE}results\\.ts$` },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    exclude: { path: '^packages/[^/]+/(dist|\\.tsbuild|coverage)/' },
    tsPreCompilationDeps: true,
    combinedDependencies: true,
    tsConfig: { fileName: 'tsconfig.base.json' },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'default'],
    },
  },
};
