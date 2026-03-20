# YouTube Mark as Watched

A userscript that adds a "Mark as watched" control button to YouTube thumbnails.

The script is designed to blend into YouTube's existing UI. The control appears in YouTube's hover action column and
follows the same interaction pattern as the built-in thumbnail actions.

## Installation

1. Install a userscript manager in your browser. (such as Tampermonkey or Violentmonkey)
2. Open [yt-mark-as-watched.user.js](./yt-mark-as-watched.user.js).
3. Create a new userscript in your manager and paste the file contents, or use the raw file URL after publishing the
   repository.
4. Visit YouTube and reload any open tabs.

## Limitations

- The script depends on YouTube's internal DOM and request shape, so YouTube UI changes can break it.
- Anonymous sessions are not supported.

## License

This project is licensed under the GNU General Public License v3.0. See the [LICENSE](./LICENSE) file for details.
