// app.json is the config. This file only adjusts it for builds.
const { withSettingsGradle } = require('expo/config-plugins');

module.exports = ({ config }) => {
  // For a sideload build (no Apple Developer account) the widget and Live Activity extension is left out,
  // because it needs an app group and push entitlements a free Apple ID cannot sign.
  if (process.env.WRK_SIDELOAD === '1') {
    config.plugins = (config.plugins || []).filter((p) => (Array.isArray(p) ? p[0] : p) !== 'expo-widgets');
  }
  // Gradle refuses a project name that ends with a dot ("wrk."). The app keeps "wrk." as its name on the phone;
  // only the Gradle project is called "wrk".
  return withSettingsGradle(config, (c) => {
    c.modResults.contents = c.modResults.contents.replace(/rootProject\.name\s*=\s*['"][^'"]*['"]/, "rootProject.name = 'wrk'");
    return c;
  });
};
