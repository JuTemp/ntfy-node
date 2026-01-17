# ntfy-node

This is a Node implementation based on parts of the ntfy documentation.

[ntfy-docs](https://docs.ntfy.sh/publish/)


## Deprecated

The Android platform uses the Bionic C API platform, not glibc and musl.

However, Bun does not provide Bionic cross-compilation options, making it impossible to compile to the Android platform (unless a Docker-like polyfill is used).

The code is also very simple and has little value.
