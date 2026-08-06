## Summary

<!-- What changed and why? -->

## Compatibility

- [ ] No wire-protocol change
- [ ] Desktop ↔ Desktop tested
- [ ] Desktop ↔ Android tested
- [ ] Android ↔ Desktop tested
- [ ] Android ↔ Android tested

## Validation

- [ ] `npm run build`
- [ ] `cargo test --release --manifest-path native-core/Cargo.toml`
- [ ] `./gradlew testDebugUnitTest assembleDebug`

## Performance and security impact

<!-- Include reproducible measurements for performance claims. Describe any
trust-boundary, cryptography, ticket, file-I/O, or resource-usage changes. -->

## Documentation

- [ ] Architecture documentation updated when responsibilities changed
- [ ] Performance documentation updated when behavior or tuning changed
- [ ] No credentials, connection tickets, generated binaries, or user data added
