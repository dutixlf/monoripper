{
  lib,
  stdenv,
  bun,
  bun2nix,
  makeWrapper,
  python3,
  runCommand,
  autoPatchelfHook,
  jq,
}:
let
  manifest = lib.importJSON ../package.json;
  inherit (manifest) version;
  pinned = lib.fileContents ../.bun-version;

  src = lib.fileset.toSource {
    root = ../.;
    fileset = lib.fileset.unions [
      ../package.json
      ../bun.lock
      ../bun.nix
      ../.bun-version
      ../tsconfig.json
      ../tsconfig.build.json
      ../README.md
      ../src
      ../tests
      ../scripts
      ../examples
      ../specs
    ];
  };

  bunDeps = bun2nix.fetchBunDeps { bunNix = ../bun.nix; };

  # embedded-postgres ships prebuilt glibc binaries for the test suite only. Its postinstall would
  # create soname links; do that here, then patch. Optional PL extensions stay unresolved.
  postgresKey =
    let
      arch = if stdenv.hostPlatform.isAarch64 then "arm64" else "x64";
    in
    "@embedded-postgres/linux-${arch}@${manifest.devDependencies.embedded-postgres}";
  testDeps = bun2nix.fetchBunDeps {
    bunNix = ../bun.nix;
    overrides.${postgresKey} =
      pkg:
      runCommand "embedded-postgres-patched"
        {
          nativeBuildInputs = [
            autoPatchelfHook
            jq
          ];
          buildInputs = [ stdenv.cc.cc.lib ];
        }
        ''
          cp -r ${pkg} $out
          chmod -R u+w $out
          root=$(dirname "$(find $out -path '*/native/pg-symlinks.json' -print -quit)")/..
          jq -r '.[] | "\(.source) \(.target)"' $root/native/pg-symlinks.json | while read source target; do
            ln -sf "$(basename "$source")" "$root/$target"
          done
          addAutoPatchelfSearchPath $root/native/lib
          autoPatchelfIgnoreMissingDeps=(libpython3.6m.so.1.0 libperl.so.5.26 libtcl8.6.so)
          autoPatchelf $root
        '';
  };

  # Shared offline install; phases below decide what to build or run.
  base =
    args:
    stdenv.mkDerivation (
      {
        inherit version src;
        bunDeps = args.bunDeps or bunDeps;
        dontRunLifecycleScripts = true;
        nativeBuildInputs = [ bun2nix.hook ] ++ (args.nativeBuildInputs or [ ]);
        dontUseBunBuild = true;
        dontUseBunCheck = true;
        dontUseBunInstall = true;
        bunInstallFlags = [ "--linker=hoisted" ];
      }
      // removeAttrs args [
        "nativeBuildInputs"
        "bunDeps"
      ]
    );

  checkWith =
    name: script:
    base {
      pname = "monoripper-check-${name}";
      bunDeps = testDeps;
      nativeBuildInputs = [ python3 ];
      buildPhase = ''
        runHook preBuild
        export HOME=$TMPDIR
        ${script}
        runHook postBuild
      '';
      installPhase = "touch $out";
    };
in
assert lib.assertMsg (
  bun.version == pinned
) "nixpkgs bun ${bun.version} differs from .bun-version ${pinned}";
rec {
  tarball = base {
    pname = "monoripper-tarball";
    buildPhase = ''
      runHook preBuild
      bun run build
      runHook postBuild
    '';
    installPhase = ''
      runHook preInstall
      mkdir -p $out
      bun pm pack --ignore-scripts --filename $out/monoripper-${version}.tgz
      ln -s monoripper-${version}.tgz $out/monoripper.tgz
      runHook postInstall
    '';
  };

  cli = base {
    pname = "monoripper";
    nativeBuildInputs = [ makeWrapper ];
    buildPhase = ''
      runHook preBuild
      bun run build
      rm -rf node_modules
      bun install --frozen-lockfile --production --ignore-scripts --linker=hoisted
      runHook postBuild
    '';
    installPhase = ''
      runHook preInstall
      mkdir -p $out/lib/monoripper $out/bin
      cp -r dist node_modules package.json README.md $out/lib/monoripper/
      makeWrapper ${lib.getExe bun} $out/bin/monoripper --add-flags $out/lib/monoripper/dist/cli.js
      runHook postInstall
    '';
    meta = {
      description = manifest.description;
      mainProgram = "monoripper";
      platforms = lib.platforms.linux;
    };
  };

  checks = {
    typecheck = checkWith "typecheck" "bun run typecheck";
    tests = checkWith "tests" "bun test tests";
    specs = checkWith "specs" "python3 scripts/check-specs.py";
    bun-nix = runCommand "monoripper-check-bun-nix" { nativeBuildInputs = [ bun2nix ]; } ''
      bun2nix -l ${../bun.lock} -o generated.nix
      diff -u ${../bun.nix} generated.nix
      touch $out
    '';
    cli = runCommand "monoripper-check-cli" { } ''
      ${cli}/bin/monoripper --help | grep -q 'monoripper serve'
      tar -tzf ${tarball}/monoripper.tgz | grep -q 'package/dist/cli.js'
      touch $out
    '';
  };
}
