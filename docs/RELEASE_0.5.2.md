# dsh-jand 0.5.2

The settings page opens from local transcript summaries. Selecting a record loads that record’s full details. Relay health updates in the background, so the history remains usable while the network check runs.

On the desktop test profile with 13 records, the local history read went from 192 ms to 2 ms and the number of per-record Jand inspections went from 13 to zero. The displayed list fields matched. Desktop reload and the improved responsiveness were confirmed on macOS arm64.

The package still uses the pinned Jand 0.5.0 kernel. Install or update with the instructions in the [README](../README.md).
