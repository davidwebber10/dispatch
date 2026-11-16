# Box image releases

A hosted box image is released with a tag `box-v<base>-<n>` (for example `box-v4.7.4-1`), where `<base>` is the normal Dispatch version in `package.json` and `<n>` counts box builds of that base, and the image is published as `ghcr.io/davidwebber10/dispatch-box:<base>-box.<n>` (`4.7.4-box.1`). The desktop updater offers only `v<major>.<minor>.<patch>` tags, so a box tag is never offered as a desktop update; never tag a box build `v…`, never bump `package.json` for one, and never make a GitHub Release for one.
