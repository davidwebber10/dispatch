# Box image releases

A hosted box image is released with a git tag `<base>-box.<n>` (for example `4.7.8-box.1`), where `<base>` is the normal Dispatch version in the root `package.json` and `<n>` counts box builds of that base, and the tag is also the image version (`ghcr.io/davidwebber10/dispatch-box:4.7.8-box.1`). The desktop updater offers only `v<major>.<minor>.<patch>` tags, so a box tag is never offered as a desktop update; never tag a box build `v…`, never bump `package.json` for one, and never make a GitHub Release for one.
