# Licensing

SanRemes is a fork of OpenMausBot, open source under the [Apache License
2.0](LICENSE). The upstream project is OpenMausBot by Milind Soni
(https://github.com/milind-soni/OpenMausBot), also Apache 2.0; see
[NOTICE](NOTICE) for the copyright and attribution notices this fork keeps.

## No enterprise layer in this fork

Upstream ships an `enterprise/` folder that is source-available under its own
OpenMausBot Enterprise License, not Apache 2.0. This fork does not include it:
the folder was deleted, so there are no enterprise features, no license key,
and no hosted/white-label offering here. The server reports
`{"edition":"oss"}`. The `server/enterprise.ts` hook stays in the tree and
reports the open-source edition when no layer is present, exactly as upstream
designed it.

## Contributions

Contribute under Apache 2.0. No DCO sign-off or CLA is required. Submit only
code you wrote or have the right to contribute.

## Third-party components and trademarks

Bundled third-party software keeps its own licenses; notices, license texts,
source locations and the SBOM are listed in [NOTICE](NOTICE) and
[`third_party/`](third_party/). The OpenMausBot and MausBot names and the
mascot are trademarks of Supamaus Software Private Limited; the Apache License
does not grant trademark rights (section 6). This fork is named SanRemes and
does not use those names or the mascot in its branding.
