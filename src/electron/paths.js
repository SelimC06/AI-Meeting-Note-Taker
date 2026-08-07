import path from 'path';

// Wraps path.join with proper arguments (rather than string-concatenating
// a '/dist-react/...' suffix onto appPath, which defeats path.join's
// separator handling entirely -- see main.js's resolveRailFile and
// createWindow, which previously did exactly that).
export function distReactPath(appPath, ...segments) {
    return path.join(appPath, 'dist-react', ...segments);
}
