'use strict';

(function(){
	const canvas = document.getElementById('game');
	const ctx = canvas.getContext('2d');
	const timerEl = document.getElementById('timer');
	const statusEl = document.getElementById('status');
	const restartBtn = document.getElementById('restart');

	// Game config
	const GRID_WIDTH = 13; // columns (q)
	const GRID_HEIGHT = 11; // rows (r)
	const GHOST_COUNT = 3;
	const ROUND_SECONDS = 60;
	const WALL_COLOR = '#394056';
	const DOOR_CLOSED_COLOR = '#e7b416';
	const DOOR_OPEN_COLOR = '#6dd37b';
	const PLAYER_COLOR = '#4fd1ff';
	const GHOST_COLOR = '#ff5b77';
	const HOME_COLOR = '#9cff6d';
	const FLOOR_COLOR = '#151923';
	const FLOOR_ALT_COLOR = '#121623';
	const OVERLAY_DARK = 'rgba(0,0,0,0.65)';

	// Deterministic maze seed (keeps the maze static across runs)
	const MAZE_SEED = 133742069;
	function mulberry32(seed) {
		let t = seed >>> 0;
		return function() {
			t += 0x6D2B79F5;
			let x = Math.imul(t ^ t >>> 15, 1 | t);
			x ^= x + Math.imul(x ^ x >>> 7, 61 | x);
			return ((x ^ x >>> 14) >>> 0) / 4294967296;
		};
	}
	function seededShuffle(arr, rng) {
		for (let i = arr.length - 1; i > 0; i--) {
			const j = Math.floor(rng() * (i + 1));
			[arr[i], arr[j]] = [arr[j], arr[i]];
		}
		return arr;
	}

	// Geometry
	let view = {
		cx: 0,
		cy: 0,
		radius: 24,
		hexW: 0,
		hexH: 0,
		originX: 0,
		originY: 0,
	};

	// Axial hex helpers (pointy-top)
	const DIRS = [
		{q: +1, r: 0},   // E
		{q: +1, r: -1},  // NE
		{q: 0, r: -1},   // N
		{q: -1, r: 0},   // W
		{q: -1, r: +1},  // SW
		{q: 0, r: +1},   // S
	];
	const DIR_KEY_MAP = {
		// Q W E A S D -> NW,N,NE,SW,S,SE mapping adapted for axial directions
		// We'll map: Q->W (index 3), W->N (2), E->NE (1), A->SW (4), S->S (5), D->E (0)
		'q': 3,
		'w': 2,
		'e': 1,
		'a': 4,
		's': 5,
		'd': 0,
	};

	function axialToPixel(q, r) {
		const x = view.radius * Math.sqrt(3) * (q + r/2) + view.originX;
		const y = view.radius * 1.5 * r + view.originY;
		return { x, y };
	}

	function edgeKey(q1, r1, q2, r2) {
		const a = `${q1},${r1}`;
		const b = `${q2},${r2}`;
		return a < b ? `${a}|${b}` : `${b}|${a}`;
	}

	class Grid {
		constructor(width, height) {
			this.width = width;
			this.height = height;
			this.cells = new Map(); // key: 'q,r' => cell
			this.edges = new Map(); // key: 'q1,r1|q2,r2' => { open: boolean, isDoor: boolean, doorOpen: boolean }
			for (let r = 0; r < height; r++) {
				for (let q = 0; q < width; q++) {
					this.cells.set(`${q},${r}`, { q, r });
				}
			}
		}

		inBounds(q, r) {
			return q >= 0 && q < this.width && r >= 0 && r < this.height;
		}

		neighbors(q, r) {
			const n = [];
			for (let i = 0; i < 6; i++) {
				const d = DIRS[i];
				const nq = q + d.q;
				const nr = r + d.r;
				if (this.inBounds(nq, nr)) n.push({ q: nq, r: nr, dir: i });
			}
			return n;
		}

		setEdgeOpen(q1, r1, q2, r2, isOpen) {
			const k = edgeKey(q1, r1, q2, r2);
			let e = this.edges.get(k);
			if (!e) { e = { open: false, isDoor: false, doorOpen: false }; }
			e.open = isOpen;
			this.edges.set(k, e);
		}

		getEdge(q1, r1, q2, r2) {
			return this.edges.get(edgeKey(q1, r1, q2, r2));
		}

		isPassable(q1, r1, q2, r2) {
			const e = this.getEdge(q1, r1, q2, r2);
			if (!e || !e.open) return false;
			if (e.isDoor && !e.doorOpen) return false;
			return true;
		}
	}

	function generateMaze(grid) {
		const rng = mulberry32(MAZE_SEED);
		// Randomized DFS (Recursive Backtracker)
		const visited = new Set();
		const stack = [];
		const start = { q: 0, r: Math.floor(grid.height / 2) };
		stack.push(start);
		visited.add(`${start.q},${start.r}`);

		function randShuffle(arr){
			return seededShuffle(arr, rng);
		}

		while (stack.length) {
			const cur = stack[stack.length - 1];
			const neighbors = grid.neighbors(cur.q, cur.r).filter(n => !visited.has(`${n.q},${n.r}`));
			if (neighbors.length === 0) {
				stack.pop();
				continue;
			}
			randShuffle(neighbors);
			const next = neighbors[0];
			grid.setEdgeOpen(cur.q, cur.r, next.q, next.r, true);
			visited.add(`${next.q},${next.r}`);
			stack.push({ q: next.q, r: next.r });
		}

		// Add some extra connections to reduce dead ends
		for (let r = 0; r < grid.height; r++) {
			for (let q = 0; q < grid.width; q++) {
				const options = grid.neighbors(q, r).filter(n => {
					const e = grid.getEdge(q, r, n.q, n.r);
					return !e; // no edge yet
				});
				if (options.length > 0 && rng() < 0.15) {
					const pick = options[Math.floor(rng() * options.length)];
					grid.setEdgeOpen(q, r, pick.q, pick.r, true);
				}
			}
		}

		// Place some doors on existing open edges
		const possibleDoors = [];
		for (let r = 0; r < grid.height; r++) {
			for (let q = 0; q < grid.width; q++) {
				for (const n of grid.neighbors(q, r)) {
					const e = grid.getEdge(q, r, n.q, n.r);
					if (e && e.open) {
						possibleDoors.push({ q1: q, r1: r, q2: n.q, r2: n.r });
					}
				}
			}
		}
		// Shuffle and pick a fraction as doors
		seededShuffle(possibleDoors, rng);
		const doorCount = Math.floor(possibleDoors.length * 0.18);
		for (let i = 0; i < doorCount; i++) {
			const d = possibleDoors[i];
			const k = edgeKey(d.q1, d.r1, d.q2, d.r2);
			const e = grid.edges.get(k);
			if (e) {
				e.isDoor = true;
				e.doorOpen = false;
				grid.edges.set(k, e);
			}
		}
	}

	function computeView() {
		const w = canvas.clientWidth;
		const h = canvas.clientHeight;
		canvas.width = Math.floor(w * devicePixelRatio);
		canvas.height = Math.floor(h * devicePixelRatio);
		ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
		// Fit hex radius to canvas size
		const padding = 32;
		const usableW = w - padding * 2;
		const usableH = h - padding * 2;
		// pointy-top: width per column = sqrt(3)*r, height per row = 1.5*r
		const radiusByWidth = usableW / (Math.sqrt(3) * (GRID_WIDTH - 1 + (GRID_HEIGHT - 1)/2) + 1.75);
		const radiusByHeight = usableH / (1.5 * (GRID_HEIGHT - 1) + 2.5);
		view.radius = Math.max(14, Math.min(radiusByWidth, radiusByHeight));
		view.hexW = Math.sqrt(3) * view.radius;
		view.hexH = 2 * view.radius;
		// Center grid
		const topLeft = axialToPixel(0, 0);
		const bottomRight = axialToPixel(GRID_WIDTH - 1, GRID_HEIGHT - 1);
		view.originX = padding + (w - padding*2 - (bottomRight.x - topLeft.x)) / 2 - topLeft.x + view.radius * 0.5;
		view.originY = padding + (h - padding*2 - (bottomRight.y - topLeft.y)) / 2 - topLeft.y + view.radius * 0.5;
	}

	function drawHex(x, y, radius, fill, stroke, strokeWidth = 2) {
		ctx.beginPath();
		for (let i = 0; i < 6; i++) {
			const angle = Math.PI / 180 * (60 * i - 30);
			const px = x + radius * Math.cos(angle);
			const py = y + radius * Math.sin(angle);
			if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
		}
		ctx.closePath();
		if (fill) { ctx.fillStyle = fill; ctx.fill(); }
		if (stroke) { ctx.lineWidth = strokeWidth; ctx.strokeStyle = stroke; ctx.stroke(); }
	}

	function drawEdgeSegment(q1, r1, q2, r2, color, width) {
		const p1 = axialToPixel(q1, r1);
		const p2 = axialToPixel(q2, r2);
		// Draw segment at the midpoint between hex centers towards the shared edge
		const mx = (p1.x + p2.x) / 2;
		const my = (p1.y + p2.y) / 2;
		// Draw short line representing a door or wall between cells
		ctx.lineWidth = width;
		ctx.strokeStyle = color;
		ctx.beginPath();
		ctx.moveTo(mx - 0.35 * (p2.y - p1.y), my + 0.35 * (p2.x - p1.x));
		ctx.lineTo(mx + 0.35 * (p2.y - p1.y), my - 0.35 * (p2.x - p1.x));
		ctx.stroke();
	}

	function drawFlag(x, y, size, color) {
		ctx.save();
		ctx.translate(x, y);
		ctx.strokeStyle = color;
		ctx.lineWidth = 3;
		ctx.beginPath();
		ctx.moveTo(0, -size*0.6);
		ctx.lineTo(0, size*0.6);
		ctx.stroke();
		ctx.beginPath();
		ctx.fillStyle = color;
		ctx.moveTo(0, -size*0.6);
		ctx.lineTo(size*0.7, -size*0.5);
		ctx.lineTo(0, -size*0.2);
		ctx.closePath();
		ctx.fill();
		ctx.restore();
	}

	function drawGhost(x, y, size) {
		ctx.save();
		ctx.translate(x, y);
		ctx.fillStyle = GHOST_COLOR;
		ctx.beginPath();
		ctx.arc(0, 0, size*0.55, Math.PI, 0);
		ctx.lineTo(size*0.55, size*0.55);
		ctx.lineTo(-size*0.55, size*0.55);
		ctx.closePath();
		ctx.fill();
		ctx.fillStyle = '#fff';
		ctx.beginPath();
		ctx.arc(-size*0.18, -size*0.1, size*0.12, 0, Math.PI*2);
		ctx.arc(size*0.18, -size*0.1, size*0.12, 0, Math.PI*2);
		ctx.fill();
		ctx.restore();
	}

	function drawPlayer(x, y, size) {
		ctx.save();
		ctx.translate(x, y);
		ctx.fillStyle = PLAYER_COLOR;
		ctx.beginPath();
		ctx.arc(0, 0, size*0.45, 0, Math.PI*2);
		ctx.fill();
		ctx.restore();
	}

	// Game state
	let grid;
	let player;
	let home;
	let ghosts;
	let lastMoveDir = 0;
	let countdownMs = ROUND_SECONDS * 1000;
	let running = true;
	let ended = false;
	let darken = 0; // for time-out effect

	function initGame() {
		grid = new Grid(GRID_WIDTH, GRID_HEIGHT);
		generateMaze(grid);
		player = { q: 0, r: Math.floor(GRID_HEIGHT / 2) };
		home = { q: GRID_WIDTH - 1, r: Math.floor(GRID_HEIGHT / 2) };
		ghosts = [];
		// Place ghosts away from player and home
		for (let i = 0; i < GHOST_COUNT; i++) {
			let q, r; let safety = 1000;
			do {
				q = Math.floor(Math.random() * GRID_WIDTH);
				r = Math.floor(Math.random() * GRID_HEIGHT);
				safety--;
			} while (safety > 0 && (Math.abs(q - player.q) + Math.abs(r - player.r) < 4 || (q === home.q && r === home.r)));
			ghosts.push({ q, r, cooldown: Math.random() * 300 });
		}
		countdownMs = ROUND_SECONDS * 1000;
		running = true;
		ended = false;
		darken = 0;
		statusEl.textContent = '';
	}

	function tryMove(entity, dirIdx) {
		const d = DIRS[dirIdx];
		const nq = entity.q + d.q;
		const nr = entity.r + d.r;
		if (!grid.inBounds(nq, nr)) return false;
		if (!grid.isPassable(entity.q, entity.r, nq, nr)) return false;
		entity.q = nq;
		entity.r = nr;
		return true;
	}

	function openAdjacentDoor() {
		// Open the first closed door adjacent to the player, prioritizing last move direction
		const dirs = [lastMoveDir, 0,1,2,3,4,5];
		const seen = new Set();
		for (const di of dirs) {
			if (di == null) continue;
			if (seen.has(di)) continue; seen.add(di);
			const d = DIRS[di];
			const nq = player.q + d.q;
			const nr = player.r + d.r;
			if (!grid.inBounds(nq, nr)) continue;
			const e = grid.getEdge(player.q, player.r, nq, nr);
			if (e && e.open && e.isDoor && !e.doorOpen) {
				e.doorOpen = true;
				statusEl.textContent = 'Door opened';
				return true;
			}
		}
		statusEl.textContent = 'No closed door nearby';
		return false;
	}

	function update(dt) {
		if (!running) return;
		if (ended) return;
		countdownMs -= dt;
		if (countdownMs <= 0) {
			countdownMs = 0;
			// Time out: darken and then lose
			darken += dt / 1000;
			if (darken > 1.2) {
				lose('Time up. The ghosts caught you.');
			}
		}

		// Move ghosts randomly with simple cooldown pacing
		for (const g of ghosts) {
			g.cooldown -= dt;
			if (g.cooldown <= 0) {
				g.cooldown = 220 + Math.random() * 180; // ms per step
				const dirs = [0,1,2,3,4,5];
				for (let i = dirs.length - 1; i > 0; i--) {
					const j = Math.floor(Math.random() * (i + 1));
					[dirs[i], dirs[j]] = [dirs[j], dirs[i]];
				}
				for (const di of dirs) {
					const d = DIRS[di];
					const nq = g.q + d.q;
					const nr = g.r + d.r;
					if (!grid.inBounds(nq, nr)) continue;
					if (!grid.isPassable(g.q, g.r, nq, nr)) continue;
					g.q = nq; g.r = nr; break;
				}
			}
		}

		// Check collisions
		for (const g of ghosts) {
			if (g.q === player.q && g.r === player.r) {
				lose('A ghost caught you!');
				break;
			}
		}

		// Win check
		if (!ended && player.q === home.q && player.r === home.r) {
			win();
		}
	}

	function win() {
		ended = true;
		running = false;
		statusEl.textContent = 'You made it home!';
	}

	function lose(msg) {
		ended = true;
		running = false;
		statusEl.textContent = msg;
	}

	function formatTime(ms) {
		const total = Math.ceil(ms / 1000);
		const m = Math.floor(total / 60).toString().padStart(2, '0');
		const s = Math.floor(total % 60).toString().padStart(2, '0');
		return `${m}:${s}`;
	}

	function render() {
		ctx.clearRect(0, 0, canvas.width, canvas.height);
		// Draw floor cells
		for (let r = 0; r < grid.height; r++) {
			for (let q = 0; q < grid.width; q++) {
				const p = axialToPixel(q, r);
				const alt = (q + r) % 2 === 0 ? FLOOR_COLOR : FLOOR_ALT_COLOR;
				drawHex(p.x, p.y, view.radius * 0.95, alt, '#1f2433', 1);
			}
		}

		// Draw walls and doors
		for (const [k, e] of grid.edges.entries()) {
			// parse edge
			const [a, b] = k.split('|');
			const [q1, r1] = a.split(',').map(Number);
			const [q2, r2] = b.split(',').map(Number);
			if (!e.open) {
				// closed wall between carved cells is rare; most walls are implicit, but draw anyway
				drawEdgeSegment(q1, r1, q2, r2, WALL_COLOR, 3);
			} else if (e.isDoor) {
				drawEdgeSegment(q1, r1, q2, r2, e.doorOpen ? DOOR_OPEN_COLOR : DOOR_CLOSED_COLOR, e.doorOpen ? 3 : 4);
			}
		}

		// Draw home flag
		const homePos = axialToPixel(home.q, home.r);
		drawFlag(homePos.x, homePos.y, view.radius, HOME_COLOR);

		// Draw ghosts
		for (const g of ghosts) {
			const p = axialToPixel(g.q, g.r);
			drawGhost(p.x, p.y, view.radius);
		}
		// Draw player
		const pp = axialToPixel(player.q, player.r);
		drawPlayer(pp.x, pp.y, view.radius);

		// Darken if time is up
		if (countdownMs <= 0 && !ended) {
			ctx.fillStyle = `rgba(0,0,0,${Math.min(0.85, darken)})`;
			ctx.fillRect(0, 0, canvas.width, canvas.height);
			ctx.fillStyle = '#fff';
			ctx.font = 'bold 28px system-ui, sans-serif';
			ctx.textAlign = 'center';
			ctx.fillText('The lights go out...', canvas.width/2, canvas.height/2 - 16);
			ctx.fillText('You are surrounded.', canvas.width/2, canvas.height/2 + 16);
		}
	}

	// Input
	window.addEventListener('keydown', (e) => {
		if (ended) {
			if (e.key.toLowerCase() === 'r') { restart(); }
			return;
		}
		const key = e.key.toLowerCase();
		if (key in DIR_KEY_MAP) {
			const d = DIR_KEY_MAP[key];
			if (tryMove(player, d)) {
				lastMoveDir = d;
				statusEl.textContent = '';
			}
			e.preventDefault();
			return;
		}
		if (key === ' ') {
			openAdjacentDoor();
			e.preventDefault();
			return;
		}
		if (key === 'r') { restart(); }
	});

	restartBtn.addEventListener('click', () => restart());

	function restart() {
		initGame();
	}

	// Main loop
	let lastTs = performance.now();
	function frame(ts) {
		const dt = Math.min(100, ts - lastTs);
		lastTs = ts;
		update(dt);
		computeView();
		render();
		timerEl.textContent = formatTime(countdownMs);
		requestAnimationFrame(frame);
	}

	// Init and start
	function onResize() { computeView(); }
	window.addEventListener('resize', onResize);
	computeView();
	initGame();
	reqAF(frame);

	function reqAF(fn){ requestAnimationFrame(fn); }
})();