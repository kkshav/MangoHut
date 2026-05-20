# MangoHut

https://dashing-gecko-9ce945.netlify.app/

Static web app that uses the [OpenDota API](https://docs.opendota.com/) to summarize your recent games on **one hero**: most-built **items**, **skill build order**, and **talent** picks.

## Usage

1. **Select a hero** (required).
2. Enter your **Steam 32-bit Account ID** (numeric; see [OpenDota](https://www.opendota.com) or your Steam profile).
3. Set **# of matches** (1–500) and click **Analyze**.

Match history must be **public** for OpenDota to return data. OpenDota applies **rate limits**; very large batches may return fewer games if the API throttles (the app retries some failures).

Data is from OpenDota; not affiliated with Valve.
