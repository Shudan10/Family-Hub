'use strict';

/*
 * QR codes, for putting the calendar link on an iPhone without typing it.
 *
 * Written here rather than fetched: the app has no dependencies and talks to
 * nothing outside the house, and a link with a secret in it is the last thing
 * to hand to somebody else's QR service to draw.
 *
 * Only what a link needs: byte mode, medium error correction, versions 1 to
 * 10 -- up to 213 bytes, about twice the longest calendar link. The method is
 * the standard one from ISO/IEC 18004, laid out the way Project Nayuki's
 * reference implementation lays it out.
 */
(function () {
    // Medium error correction, per version: codewords of correction in each
    // block, and how many blocks. Index 0 is unused.
    const ECC_PER_BLOCK = [0, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26];
    const BLOCKS = [0, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5];
    const MAX_VERSION = 10;

    /** Modules left for data and correction once the fixed patterns are drawn. */
    function rawModules(ver) {
        let r = (16 * ver + 128) * ver + 64;
        if (ver >= 2) {
            const n = Math.floor(ver / 7) + 2;
            r -= (25 * n - 10) * n - 55;
            if (ver >= 7) r -= 36;
        }
        return r;
    }
    const dataCodewords = (ver) => Math.floor(rawModules(ver) / 8) - ECC_PER_BLOCK[ver] * BLOCKS[ver];

    function alignPositions(ver) {
        if (ver === 1) return [];
        const n = Math.floor(ver / 7) + 2;
        const step = Math.ceil((ver * 4 + 4) / (n * 2 - 2)) * 2;
        const out = [6];
        for (let p = ver * 4 + 10; out.length < n; p -= step) out.splice(1, 0, p);
        return out;
    }

    // ------------------------------------------------- Reed-Solomon, GF(256) --

    function gfMul(x, y) {
        let z = 0;
        for (let i = 7; i >= 0; i--) {
            z = (z << 1) ^ ((z >>> 7) * 0x11d);
            z ^= ((y >>> i) & 1) * x;
        }
        return z;
    }

    function rsDivisor(degree) {
        const r = new Array(degree).fill(0);
        r[degree - 1] = 1;
        let root = 1;
        for (let i = 0; i < degree; i++) {
            for (let j = 0; j < r.length; j++) {
                r[j] = gfMul(r[j], root);
                if (j + 1 < r.length) r[j] ^= r[j + 1];
            }
            root = gfMul(root, 0x02);
        }
        return r;
    }

    function rsRemainder(data, divisor) {
        const r = divisor.map(() => 0);
        for (const b of data) {
            const factor = b ^ r.shift();
            r.push(0);
            divisor.forEach((c, i) => {
                r[i] ^= gfMul(c, factor);
            });
        }
        return r;
    }

    // ------------------------------------------------------------ the bits --

    function codewords(bytes, ver) {
        const bits = [];
        const put = (val, len) => {
            for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1);
        };
        put(0b0100, 4); // byte mode
        put(bytes.length, ver < 10 ? 8 : 16);
        for (const b of bytes) put(b, 8);
        const cap = dataCodewords(ver) * 8;
        put(0, Math.min(4, cap - bits.length));
        put(0, (8 - (bits.length % 8)) % 8);
        for (let pad = 0xec; bits.length < cap; pad ^= 0xec ^ 0x11) put(pad, 8);

        const data = [];
        for (let i = 0; i < bits.length; i += 8) data.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0));

        // Split into blocks, give each its correction, and interleave them.
        const numBlocks = BLOCKS[ver];
        const eccLen = ECC_PER_BLOCK[ver];
        const raw = Math.floor(rawModules(ver) / 8);
        const numShort = numBlocks - (raw % numBlocks);
        const shortLen = Math.floor(raw / numBlocks);
        const divisor = rsDivisor(eccLen);
        const blocks = [];
        for (let i = 0, k = 0; i < numBlocks; i++) {
            const dat = data.slice(k, k + shortLen - eccLen + (i < numShort ? 0 : 1));
            k += dat.length;
            const ecc = rsRemainder(dat, divisor);
            if (i < numShort) dat.push(0);
            blocks.push(dat.concat(ecc));
        }
        const out = [];
        for (let i = 0; i < blocks[0].length; i++) {
            blocks.forEach((b, j) => {
                if (i !== shortLen - eccLen || j >= numShort) out.push(b[i]);
            });
        }
        return out;
    }

    // --------------------------------------------------------- the picture --

    const MASKS = [
        (x, y) => (x + y) % 2 === 0,
        (x, y) => y % 2 === 0,
        (x, y) => x % 3 === 0,
        (x, y) => (x + y) % 3 === 0,
        (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
        (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
        (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
        (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
    ];

    /* Medium correction is 00 in the format bits; the mask number follows. */
    function formatBits(mask) {
        const data = mask;
        let rem = data;
        for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
        return ((data << 10) | rem) ^ 0x5412;
    }

    /** Lower is easier for a camera to read: the four penalty rules of the standard. */
    function penalty(m) {
        const n = m.length;
        let score = 0;
        const lines = [];
        for (let i = 0; i < n; i++) {
            lines.push(m[i]);
            lines.push(m.map((row) => row[i]));
        }
        for (const line of lines) {
            let run = 1;
            for (let i = 1; i <= n; i++) {
                if (i < n && line[i] === line[i - 1]) run++;
                else {
                    if (run >= 5) score += run - 2;
                    run = 1;
                }
            }
            // Something that looks like a finder: dark-light-dark x3-light-dark
            // with four light either side.
            const s = line.map((d) => (d ? 1 : 0)).join('');
            const padded = `0000${s}0000`;
            for (const pat of ['10111010000', '00001011101']) {
                for (let i = padded.indexOf(pat); i >= 0; i = padded.indexOf(pat, i + 1)) score += 40;
            }
        }
        for (let y = 0; y < n - 1; y++) {
            for (let x = 0; x < n - 1; x++) {
                const c = m[y][x];
                if (c === m[y][x + 1] && c === m[y + 1][x] && c === m[y + 1][x + 1]) score += 3;
            }
        }
        const dark = m.reduce((a, row) => a + row.filter(Boolean).length, 0);
        const total = n * n;
        score += (Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1) * 10;
        return score;
    }

    /** The QR code for `text`, as rows of booleans (true is dark). */
    function encode(text) {
        const bytes = new TextEncoder().encode(text);
        let ver = 1;
        while (ver <= MAX_VERSION && 4 + (ver < 10 ? 8 : 16) + bytes.length * 8 > dataCodewords(ver) * 8) ver++;
        if (ver > MAX_VERSION) throw new Error('That is too long for a QR code here.');

        const size = ver * 4 + 17;
        const m = Array.from({ length: size }, () => new Array(size).fill(false));
        const fixed = Array.from({ length: size }, () => new Array(size).fill(false));
        const set = (x, y, dark) => {
            m[y][x] = dark;
            fixed[y][x] = true;
        };

        for (let i = 0; i < size; i++) {
            set(6, i, i % 2 === 0);
            set(i, 6, i % 2 === 0);
        }
        const finder = (cx, cy) => {
            for (let dy = -4; dy <= 4; dy++) {
                for (let dx = -4; dx <= 4; dx++) {
                    const x = cx + dx;
                    const y = cy + dy;
                    const d = Math.max(Math.abs(dx), Math.abs(dy));
                    if (x >= 0 && x < size && y >= 0 && y < size) set(x, y, d !== 2 && d !== 4);
                }
            }
        };
        finder(3, 3);
        finder(size - 4, 3);
        finder(3, size - 4);

        const align = alignPositions(ver);
        const last = align.length - 1;
        align.forEach((ax, i) =>
            align.forEach((ay, j) => {
                // Not where the alignment pattern would sit on a finder.
                if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) return;
                for (let dy = -2; dy <= 2; dy++) {
                    for (let dx = -2; dx <= 2; dx++) set(ax + dx, ay + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
                }
            }),
        );

        const drawFormat = (mask) => {
            const bits = formatBits(mask);
            const bit = (i) => ((bits >>> i) & 1) === 1;
            for (let i = 0; i <= 5; i++) set(8, i, bit(i));
            set(8, 7, bit(6));
            set(8, 8, bit(7));
            set(7, 8, bit(8));
            for (let i = 9; i < 15; i++) set(14 - i, 8, bit(i));
            for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(i));
            for (let i = 8; i < 15; i++) set(8, size - 15 + i, bit(i));
            set(8, size - 8, true);
        };
        drawFormat(0); // reserves the area; drawn for real once the mask is chosen

        if (ver >= 7) {
            let rem = ver;
            for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
            const bits = (ver << 12) | rem;
            for (let i = 0; i < 18; i++) {
                const dark = ((bits >>> i) & 1) === 1;
                const a = size - 11 + (i % 3);
                const b = Math.floor(i / 3);
                set(a, b, dark);
                set(b, a, dark);
            }
        }

        // The data, in two-column zigzags from the bottom right.
        const words = codewords(bytes, ver);
        let i = 0;
        for (let right = size - 1; right >= 1; right -= 2) {
            if (right === 6) right = 5;
            for (let vert = 0; vert < size; vert++) {
                for (let j = 0; j < 2; j++) {
                    const x = right - j;
                    const upward = ((right + 1) & 2) === 0;
                    const y = upward ? size - 1 - vert : vert;
                    if (!fixed[y][x] && i < words.length * 8) {
                        m[y][x] = ((words[i >>> 3] >>> (7 - (i & 7))) & 1) === 1;
                        i++;
                    }
                }
            }
        }

        const applyMask = (k) => {
            for (let y = 0; y < size; y++) {
                for (let x = 0; x < size; x++) if (!fixed[y][x] && MASKS[k](x, y)) m[y][x] = !m[y][x];
            }
        };
        let best = 0;
        let bestScore = Infinity;
        for (let k = 0; k < 8; k++) {
            applyMask(k);
            drawFormat(k);
            const score = penalty(m);
            if (score < bestScore) {
                best = k;
                bestScore = score;
            }
            applyMask(k); // undo
        }
        applyMask(best);
        drawFormat(best);
        return m;
    }

    /**
     * An SVG of the code. Always black on white with a quiet border, whatever
     * the theme: a camera reads dark-on-light, and a Halloween-orange code on
     * near-black is a code nobody's phone will pick up.
     */
    function toSvg(text, margin = 4) {
        const m = encode(text);
        const s = m.length + margin * 2;
        let d = '';
        m.forEach((row, y) =>
            row.forEach((dark, x) => {
                if (dark) d += `M${x + margin} ${y + margin}h1v1h-1z`;
            }),
        );
        return (
            `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${s} ${s}" shape-rendering="crispEdges" role="img" aria-label="QR code">` +
            `<rect width="${s}" height="${s}" fill="#fff"/><path d="${d}" fill="#000"/></svg>`
        );
    }

    window.QR = { encode, toSvg };
})();
