# Box image releases

A hosted box image is released with a git tag `box-<base>-<n>` (for example `box-4.7.8-1`), where `<base>` is the normal Dispatch version in the root `package.json` and `<n>` counts box builds of that base, and that one name is also the image tag (`ghcr.io/davidwebber10/dispatch-box:box-4.7.8-1`) and the version that OS shows. The desktop updater offers only `v<major>.<minor>.<patch>` tags, so a box tag is never offered as a desktop update; never tag a box build `v…`, never bump `package.json` for one, and never make a GitHub Release for one.
