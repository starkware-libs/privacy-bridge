// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 StarkWare Industries Ltd.

// This proxy runs on a server runtime (not in the browser bundle), where
// process.env is available but @types/node is not part of this package's types.
declare const process: { env: Record<string, string | undefined> };
