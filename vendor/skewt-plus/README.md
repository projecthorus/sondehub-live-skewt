# Vendored skewt-plus
- Upstream: https://github.com/rittels/skewt-js
- Package: https://registry.npmjs.org/skewt-plus/-/skewt-plus-1.0.421.tgz

- Temperature and wind no longer require dewpoint.
- Dewpoint uses a D3 `defined` predicate to leave gaps for missing values,
  accepts 0°C, and can begin above the surface.
- Parcel calculations require valid surface dewpoint. Empty parcel paths and
  labels replace previous results when surface dewpoint is unavailable.
- Cloud shading is cleared and omitted unless the whole profile has dewpoint,
  avoiding unsupported interpolation through missing humidity.
- Humidity derivation accepts zero-degree temperature and dewpoint.
- Missing dewpoint hides its tooltip marker and displays an unavailable label.