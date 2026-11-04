{
  description = "Run selected Elysia contexts in isolated Bun processes";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-26.05";
    bun2nix = {
      url = "github:nix-community/bun2nix";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  nixConfig = {
    extra-substituters = [ "https://nix-community.cachix.org" ];
    extra-trusted-public-keys = [
      "nix-community.cachix.org-1:mB9FSh9qf2dCimDSUo8Zy7bkq5CX+/rkCWyvRCYg3Fs="
    ];
  };

  outputs =
    {
      self,
      nixpkgs,
      bun2nix,
    }:
    let
      systems = [
        "x86_64-linux"
        "aarch64-linux"
      ];
      forAll =
        f:
        nixpkgs.lib.genAttrs systems (
          system:
          f (
            import nixpkgs {
              inherit system;
              overlays = [ bun2nix.overlays.default ];
            }
          )
        );
      build = pkgs: pkgs.callPackage ./nix/package.nix { };
    in
    {
      packages = forAll (pkgs: {
        default = (build pkgs).cli;
        inherit (build pkgs) cli tarball;
      });

      apps = forAll (pkgs: {
        default = {
          type = "app";
          program = "${(build pkgs).cli}/bin/monoripper";
          meta.description = "Monoripper CLI";
        };
      });

      checks = forAll (pkgs: (build pkgs).checks);

      devShells = forAll (pkgs: {
        default = pkgs.mkShell {
          packages = [
            pkgs.bun
            pkgs.bun2nix
            pkgs.python3
            pkgs.git
          ];
        };
      });

      formatter = forAll (pkgs: pkgs.nixfmt);
    };
}
