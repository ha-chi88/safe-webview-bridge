import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { gzipSync } from "node:zlib";

import { build } from "esbuild";
import Metro from "metro";
import { getDefaultConfig, mergeConfig } from "metro-config";

const root = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(import.meta.url);
const packageManager = JSON.parse(
  await readFile(path.join(root, "package.json"), "utf8"),
).packageManager;
const temporary = await realpath(
  await mkdtemp(path.join(tmpdir(), "safe-webview-bridge-package-")),
);
const artifactDirectory = path.join(root, ".artifacts");
const reports = [];
const run = (command, args, cwd = root) =>
  execFileSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 120_000,
  });
const storeDirectory = path.dirname(run("corepack", ["pnpm", "store", "path"]).trim());

async function bundle(code, resolveDir = root) {
  const result = await build({
    stdin: { contents: code, resolveDir, loader: "ts" },
    bundle: true,
    write: false,
    minify: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    metafile: true,
  });
  const output = result.outputFiles[0].contents;
  return {
    bytes: output.length,
    gzip: gzipSync(output).length,
    inputs: Object.keys(result.metafile.inputs),
  };
}

function sourceNames(map) {
  return map.sections
    ? map.sections.flatMap((section) => sourceNames(section.map))
    : map.sources;
}

try {
  run("corepack", ["pnpm", "pack", "--pack-destination", temporary]);
  const tarball = (await readdir(temporary)).find((name) => name.endsWith(".tgz"));
  assert(tarball, "pnpm pack must create a tarball");
  const consumer = path.join(temporary, "consumer");
  await mkdir(consumer);
  await writeFile(
    path.join(consumer, "package.json"),
    JSON.stringify({
      name: "isolated-bridge-consumer",
      private: true,
      type: "module",
      packageManager,
      dependencies: { "safe-webview-bridge": `file:${path.join(temporary, tarball)}` },
    }),
  );
  // Reuse stored packages, but allow a clean CI runner to fetch semver metadata.
  // The isolated consumer has no schema vendor or React.
  run(
    "corepack",
    [
      "pnpm",
      "install",
      "--prefer-offline",
      "--ignore-scripts",
      "--store-dir",
      storeDirectory,
      "--config.confirmModulesPurge=false",
    ],
    consumer,
  );
  const manifest = JSON.parse(
    await readFile(
      path.join(consumer, "node_modules/safe-webview-bridge/package.json"),
      "utf8",
    ),
  );
  assert.deepEqual(Object.keys(manifest.dependencies), ["@standard-schema/spec"]);
  assert.equal(manifest.peerDependencies, undefined);
  const installed = await readdir(path.join(consumer, "node_modules/.pnpm"));
  assert(
    !installed.some((name) =>
      /^(zod|valibot|arktype|effect|react|react-native)@/.test(name),
    ),
    "No vendor or platform peer may be installed implicitly",
  );

  await writeFile(
    path.join(consumer, "smoke.mjs"),
    `
    import assert from 'node:assert/strict';
    import { createBridge, defineMessages } from 'safe-webview-bridge';
    import { createWebBridge } from 'safe-webview-bridge/web';
    import { createNativeBridge } from 'safe-webview-bridge/react-native';
    const messages = defineMessages({ value: { '~standard': { version: 1, vendor: 'consumer', validate: value => ({ value }) } } });
    const native = createNativeBridge({ receive: messages, allowedOrigins: ['https://app.example'], getCurrentUrl: () => 'https://app.example', getWebView: () => null });
    const web = createWebBridge({ receive: messages });
    const core = createBridge({ receive: messages, transport: { send() {} } });
    let received;
    core.on('value', value => { received = value; });
    assert.equal((await core.receive(JSON.stringify({version:1,channel:'safe-webview-bridge',type:'value',payload:42}))).ok, true);
    assert.equal(received, 42);
    assert.equal((await web.send('value', 1)).error.code, 'transport_unavailable');
    core.dispose(); native.dispose(); web.dispose();
  `,
  );
  run(process.execPath, ["smoke.mjs"], consumer);

  // Compile published declarations with no DOM, React, Node globals, or skipLibCheck escape hatch.
  await writeFile(
    path.join(consumer, "consumer.ts"),
    `
    import { createBridge, defineMessages, type MessageSchemas } from 'safe-webview-bridge';
    import { createWebBridge } from 'safe-webview-bridge/web';
    import { createNativeBridge } from 'safe-webview-bridge/react-native';
    const messages = defineMessages({ value: { '~standard': { version: 1, vendor: 'consumer', validate: (value: unknown) => ({ value }) } } } satisfies MessageSchemas);
    type Contract = { toNative: typeof messages; toWeb: typeof messages };
    const native = createNativeBridge<Contract>({ receive: messages, allowedOrigins: ['https://app.example'], getCurrentUrl: () => 'https://app.example', getWebView: () => null });
    const web = createWebBridge<Contract>({ receive: messages, getWindow: () => undefined });
    const core = createBridge({ receive: messages, transport: { send() {} } });
    void native.send('value', 42); void web.send('value', 42); core.dispose(); native.dispose(); web.dispose();
    // @ts-expect-error invalid message name must still fail in an isolated consumer
    web.send('unknown', 42);
  `,
  );
  await writeFile(
    path.join(consumer, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        target: "ES2022",
        module: "NodeNext",
        moduleResolution: "NodeNext",
        lib: ["ES2022"],
        types: [],
        strict: true,
        exactOptionalPropertyTypes: true,
        noEmit: true,
        skipLibCheck: false,
      },
      files: ["consumer.ts"],
    }),
  );
  run(
    process.execPath,
    [path.join(root, "node_modules/typescript/bin/tsc"), "-p", "tsconfig.json"],
    consumer,
  );

  for (const [entry, exported] of [
    ["safe-webview-bridge", "createBridge, defineMessages"],
    ["safe-webview-bridge/web", "createWebBridge"],
    ["safe-webview-bridge/react-native", "createNativeBridge"],
  ]) {
    const measured = await bundle(`export { ${exported} } from '${entry}';`, consumer);
    assert(
      !measured.inputs.some((input) =>
        /node_modules\/(zod|valibot|arktype|effect|react|react-native|@standard-schema)\//.test(
          input,
        ),
      ),
      `Unexpected runtime dependency in ${entry}`,
    );
    assert(measured.gzip < 6_144, `${entry} exceeds the 6 KiB gzip bridge budget`);
    reports.push({ name: entry, bytes: measured.bytes, gzip: measured.gzip });
  }

  const vendors = [
    ["zod", "import { z } from 'zod'; const schema = z.object({name:z.string()});"],
    [
      "zod/mini",
      "import * as z from 'zod/mini'; const schema = z.object({name:z.string()});",
    ],
    [
      "valibot",
      "import * as v from 'valibot'; const schema = v.object({name:v.string()});",
    ],
    ["arktype", "import { type } from 'arktype'; const schema = type({name:'string'});"],
    [
      "effect",
      "import * as Schema from 'effect/Schema'; const schema = Schema.toStandardSchemaV1(Schema.Struct({name:Schema.String}));",
    ],
  ];
  for (const [name, definition] of vendors) {
    const baseline = await bundle(
      `${definition} export const validate = (data) => schema['~standard'].validate(data);`,
    );
    const withBridge = await bundle(
      `${definition} import { createBridge } from 'safe-webview-bridge'; export const bridge = createBridge({receive:{value:schema},transport:{send(){}}});`,
    );
    reports.push({
      name,
      schemaGzip: baseline.gzip,
      withBridgeGzip: withBridge.gzip,
      bridgeDeltaGzip: withBridge.gzip - baseline.gzip,
    });
  }

  const typedOutbound = await bundle("export { bridge } from './test/bundle/web.ts';");
  assert(
    !typedOutbound.inputs.some((input) =>
      /node_modules\/(effect|zod|arktype)\//.test(input),
    ),
    "Type-only outgoing schemas leaked into the web bundle",
  );
  assert(
    !typedOutbound.inputs.some((input) => input.endsWith("to-native.ts")),
    "An outgoing schema module was evaluated",
  );
  reports.push({
    name: "Web with type-only Effect outbound",
    bytes: typedOutbound.bytes,
    gzip: typedOutbound.gzip,
  });

  // Metro consumes the installed tarball with React Native's Babel preset.
  await writeFile(
    path.join(consumer, "babel.config.cjs"),
    `module.exports = { presets: [${JSON.stringify(require.resolve("@react-native/babel-preset"))}] };\n`,
  );
  await writeFile(
    path.join(consumer, "metro-entry.js"),
    `
    import { createNativeBridge } from 'safe-webview-bridge/react-native';
    const bridge = createNativeBridge({receive:{},allowedOrigins:['https://app.example'],getCurrentUrl:()=>'https://app.example',getWebView:()=>({postMessage(raw){globalThis.__BRIDGE_RAW__=raw;}})});
    globalThis.__BRIDGE_DONE__=bridge.send('test',{value:42}).then(result=>{bridge.dispose();return result;});
  `,
  );
  const metroConfig = mergeConfig(await getDefaultConfig(consumer), {
    projectRoot: consumer,
    watchFolders: [consumer, root],
    maxWorkers: 1,
    cacheStores: [],
    transformer: {
      asyncRequireModulePath: require.resolve("metro-runtime/src/modules/asyncRequire"),
    },
    resolver: {
      useWatchman: false,
      unstable_enablePackageExports: true,
      extraNodeModules: {
        "@babel/runtime": path.dirname(require.resolve("@babel/runtime/package.json")),
      },
    },
    reporter: { update() {} },
  });
  for (const platform of ["ios", "android"]) {
    const output = await Metro.runBuild(metroConfig, {
      entry: "metro-entry.js",
      platform,
      dev: false,
      minify: true,
      sourceMap: true,
    });
    const sources = sourceNames(JSON.parse(output.map));
    assert(sources.length > 0, "Metro must report bundled sources");
    assert(
      !sources.some((source) =>
        /node_modules\/(zod|valibot|arktype|effect|react|react-native|@standard-schema)\//.test(
          source,
        ),
      ),
      "Metro pulled an unwanted runtime dependency",
    );
    const context = { setTimeout, clearTimeout, console, URL };
    runInNewContext(output.code, context);
    assert.equal((await context.__BRIDGE_DONE__).ok, true);
    assert.equal(JSON.parse(context.__BRIDGE_RAW__).payload.value, 42);
    reports.push({
      name: `Metro ${platform} smoke`,
      bytes: output.code.length,
      modules: sources.length,
    });
  }

  await mkdir(artifactDirectory, { recursive: true });
  await writeFile(
    path.join(artifactDirectory, "bundle-sizes.json"),
    `${JSON.stringify(reports, null, 2)}\n`,
  );
  console.table(reports);
  console.log(
    "Isolated package, declarations, runtime imports, bundle budgets, and both Metro targets passed.",
  );
} finally {
  await rm(temporary, { recursive: true, force: true });
}
