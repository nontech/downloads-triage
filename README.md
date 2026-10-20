# Downloads Triage

A Mac app that sorts ~/Downloads into suggested trash, review, and keep.

## Setup

You need macOS 14 and Node.js.

```sh
npm install
Scripts/build_app.sh
open "Downloads Triage.app"
```

Leave the app in this folder. It starts a local server from the project. A Jev key is optional: paste it on first launch, or copy `.env.example` to `.env` and set `TYPESAFE_API_KEY`. Create a key at https://typesafe.ai.

## Usage

First launch asks for a Jev key. Skip leaves documents in Review. Scan Downloads, then work through Suggested trash, Review, and Keep. Nothing is deleted until you confirm Move to Trash. Undo puts trashed files back. Settings is the same page as first launch.

## Contributing

Contributions are welcome. Open an issue to start.

MIT license. See [LICENSE](LICENSE).
