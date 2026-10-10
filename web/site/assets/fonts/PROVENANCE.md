# Self-hosted font provenance (W5, F3)

Local record of the fonts shipped in `web/site/assets/fonts/`. Both are licensed under the
SIL Open Font License 1.1 and are self-hosted, so the built site loads no third-party font
at read time.

## Newsreader (display and body serif)

- Designer: Production Type.
- License: SIL Open Font License 1.1. Copyright 2020 The Newsreader Project Authors.
- License text shipped: `OFL-Newsreader.txt`.
- License verified from two official sources (both returned HTTP 200, identical text):
  - https://raw.githubusercontent.com/google/fonts/main/ofl/newsreader/OFL.txt
  - https://raw.githubusercontent.com/productiontype/Newsreader/master/OFL.txt
- Font binary: `newsreader-latin-var.woff2` (latin subset, variable opsz/wght, weight 400-500),
  served by the official Google Fonts CDN path:
  https://fonts.gstatic.com/s/newsreader/v26/cY9AfjOC1hbuyalUrK4397yjA.woff2
- sha256: `6e4f2958c3a7c4a80acde4e5a679abe7e01bc1e30b92be3c7a8b696ef401d101`

## IBM Plex Mono (code, labels, meta)

- Owner: IBM Corp. License: SIL Open Font License 1.1, with Reserved Font Name "Plex".
- License text shipped: `OFL-IBM-Plex-Mono.txt`.
- License verified from the official repository (HTTP 200):
  https://raw.githubusercontent.com/IBM/plex/master/LICENSE.txt
- Font binaries (latin subset), served by the official Google Fonts CDN paths:
  - 400: https://fonts.gstatic.com/s/ibmplexmono/v20/-F63fjptAgt5VM-kVkqdyU8n1i8q1w.woff2
    sha256 `08949f728dc52d528e69b1667d15c89a5686a4ee9a296ff90983985f99c380f7`
  - 500: https://fonts.gstatic.com/s/ibmplexmono/v20/-F6qfjptAgt5VM-kVkqdyU8n3twJwlBFgg.woff2
    sha256 `01d285447409c8a588692162439a038b8cbd7871309ee20267b0d2d91c6e8e22`
  - 600: https://fonts.gstatic.com/s/ibmplexmono/v20/-F6qfjptAgt5VM-kVkqdyU8n3vAOwlBFgg.woff2
    sha256 `0d1f0b8d0722224e32e9f28261bdc86c79115be73444ae5eceb73976a1bcdf83`

## Notes

- Only the `latin` subset is shipped (the site is es/en); other subsets are intentionally not
  vendored to keep the payload small.
- The two license texts are copied into the built `dist/assets/fonts/` so the OFL requirement
  that the license accompany the font is satisfied in the published artifact.
