/***********************************************
 * Ripple Grid + Multi-touch Knob for HOLD_MS
 * - 长按拖动：沿途连续发射波源；格子循环「□→○→△→□」
 * - 松手：停止发射；已触发格子走完当前循环回到正方形后停
 * - 两指捏合/张开：进入旋钮控制模式（冻结画面），调 HOLD_MS
 * - 单指点击空白：退出控制模式，恢复播放
 ***********************************************/

// ===== 可调参数 =====
const COLS = 6, ROWS = 8, GAP = 16;
const N = 120, SW_MAIN = 3.0, BASE_ALPHA = 230;

const HALF_MS = 300;                   // 变形时间固定
let   HOLD_MS = 1500;                  // 停留时间（旋钮控制）
const HOLD_MIN = 30, HOLD_MAX = 3000;  // ★ 旋钮范围（显示同步）

const LONGPRESS_MS = 350;
const WAVE_SPEED_PX_PER_MS = 0.8;
const ACTIVATION_BAND = 40;

const EMIT_INTERVAL_MS = 40;
const MAX_EMITTERS = 800;

// ===== 派生量（随 HOLD_MS 更新）=====
let SEG_MS = HALF_MS + HOLD_MS;
let CYCLE_MS = 3 * SEG_MS;

// ===== 网格排布 =====
let tileDiam, rTile, sScale, marginX, marginY;

// ===== 形状缓存 =====
let triX=new Float32Array(N), triY=new Float32Array(N);
let sqrX=new Float32Array(N), sqrY=new Float32Array(N);
let cirX=new Float32Array(N), cirY=new Float32Array(N);
let rBase=120;

// ===== 每格状态 =====
// startMs:  -1 未触发；>=0 激活时间（逻辑时钟）；-2 已完成
// stopAtMs: -1 长按中不需要；>=0 松手后该格应在此时刻（含）停止在□
let startMs=[], stopAtMs=[];

// ===== 发射器（沿拖动路径持续产生）=====
let emitters = []; // {x,y,t0}
let lastEmitMs = 0;
let maxReachDist = 0;

// ===== 交互与时钟 =====
let isPointerDown=false, isLongPress=false;
let lastPointer={x:0,y:0};

// 逻辑时钟（可冻结）
let logicalNow = 0;     // 累加的逻辑时间（ms）
let lastReal = 0;       // 上一帧真实时间
let clockPaused = false;

// 长按判定起点（逻辑时钟）
let downAtMs = 0;

// ===== 旋钮控制模式 =====
const KNOB_RADIUS = 80;
const KNOB_SENSITIVITY = 3.0; // 每 1px 距离变化 ≈ 3ms
let knob = {
  active: false,
  center: {x:0, y:0},
  baseDist: 0,
  lastDist: 0,
  angle: 0,        // 仅视觉
  enteredAt: 0
};

// ===== 基础 =====
function setup(){
  createCanvas(windowWidth, windowHeight);
  smooth(); strokeJoin(ROUND); strokeCap(ROUND); noFill();

  buildTrianglePoints(triX,triY,N,rBase);
  buildSquarePoints (sqrX,sqrY,N,rBase);
  buildCirclePoints (cirX,cirY,N,rBase);

  initStates();
  computeGridLayout();

  lastReal = millis();
}

function windowResized(){ resizeCanvas(windowWidth,windowHeight); computeGridLayout(); }

function initStates(){
  startMs = Array.from({length:ROWS},()=>Array(COLS).fill(-1));
  stopAtMs = Array.from({length:ROWS},()=>Array(COLS).fill(-1));
}

function resetForNewGesture(){
  initStates();
  emitters.length = 0;
  lastEmitMs = 0;
}

// ===== 逻辑时钟：可冻结 =====
function updateClock(){
  const realNow = millis();
  const dt = realNow - lastReal;
  if(!clockPaused) logicalNow += dt;
  lastReal = realNow;
}

// ===== 主循环 =====
function draw(){
  updateClock();

  // 随 HOLD_MS 更新节奏
  SEG_MS = HALF_MS + HOLD_MS;
  CYCLE_MS = 3 * SEG_MS;

  background(0);

  if(knob.active){
    // 控制模式：冻结画面 + 旋钮
    clockPaused = true;
    renderGrid();        // logicalNow 不变，画面冻结
    drawKnobOverlay();   // 画旋钮
    return;
  }else{
    clockPaused = false;
  }

  // 非控制模式：模拟 + 渲染
  simulateEmittersAndActivations();
  renderGrid();
}

// ===== 模拟与渲染 =====
function simulateEmittersAndActivations(){
  // 长按判定
  if(isPointerDown && !isLongPress){
    if(logicalNow - downAtMs >= LONGPRESS_MS){
      isLongPress = true;
      resetForNewGesture();
      spawnEmitter(logicalNow, lastPointer.x, lastPointer.y);
    }
  }
  // 长按中：沿路径周期发射
  if(isLongPress && logicalNow - lastEmitMs >= EMIT_INTERVAL_MS){
    spawnEmitter(logicalNow, lastPointer.x, lastPointer.y);
  }
  // 清理过期发射器
  pruneEmitters(logicalNow);
}

function renderGrid(){
  const now = logicalNow;

  for(let iy=0; iy<ROWS; iy++){
    for(let ix=0; ix<COLS; ix++){
      const c = tileCenter(ix,iy);

      // 未触发 → 检查是否被任一发射器命中
      if(isLongPress && startMs[iy][ix] < 0){
        if(hitByAnyEmitter(now, c.x, c.y)){
          startMs[iy][ix] = now;
          stopAtMs[iy][ix] = -1;
        }
      }

      // 绘制
      push();
      translate(c.x,c.y);
      stroke(255, BASE_ALPHA);
      strokeWeight(SW_MAIN);

      const t0 = startMs[iy][ix];
      const tStop = stopAtMs[iy][ix];

      if(t0 === -1 || t0 === -2){
        drawShape(sqrX,sqrY); // 未触发 / 已完成：正方形
      }else{
        const elapsed = now - t0;

        if(isLongPress){
          drawLoopCycle(elapsed, sScale); // 长按：无限循环
        }else{
          // 松手：收尾到下一个□边界
          if(tStop === -1){
            const cycles = Math.ceil(elapsed / CYCLE_MS);
            stopAtMs[iy][ix] = t0 + cycles*CYCLE_MS;
          }
          if(now >= stopAtMs[iy][ix]){
            startMs[iy][ix] = -2;
            drawShape(sqrX,sqrY);
          }else{
            drawLoopCycle(elapsed, sScale);
          }
        }
      }
      pop();
    }
  }
}

// ===== 发射器 =====
function spawnEmitter(t, x, y){
  emitters.push({ t0:t, x, y });
  lastEmitMs = t;
  if(emitters.length > MAX_EMITTERS){
    emitters.splice(0, emitters.length - MAX_EMITTERS);
  }
}
function hitByAnyEmitter(now, px, py){
  for(let i=emitters.length-1; i>=0; i--){
    const e = emitters[i];
    const age = now - e.t0;
    if(age < 0) continue;
    const R = age * WAVE_SPEED_PX_PER_MS;
    const d = dist(px,py, e.x,e.y);
    if(Math.abs(d - R) <= ACTIVATION_BAND) return true;
  }
  return false;
}
function pruneEmitters(now){
  let cut = 0;
  for(let i=0;i<emitters.length;i++){
    const age = now - emitters[i].t0;
    const R = age * WAVE_SPEED_PX_PER_MS;
    if(R < maxReachDist){ cut = i; break; }
    if(i === emitters.length-1) cut = emitters.length;
  }
  if(cut > 0) emitters.splice(0, cut);
}

// ===== 形变（循环：□→○→△→□）=====
function drawLoopCycle(elapsedMs, scale){
  const p = elapsedMs % CYCLE_MS;
  const stage = Math.floor(p / SEG_MS); // 0:□→○, 1:○→△, 2:△→□
  const pin = p - stage*SEG_MS;
  const k = (pin < HALF_MS) ? easeInOutCubic(pin / HALF_MS) : 1.0;

  let ax,ay,bx,by;
  if(stage===0){ ax=sqrX; ay=sqrY; bx=cirX; by=cirY; }
  else if(stage===1){ ax=cirX; ay=cirY; bx=triX; by=triY; }
  else { ax=triX; ay=triY; bx=sqrX; by=sqrY; }

  beginShape();
  for(let i=0;i<N;i++){
    vertex( lerp(ax[i],bx[i],k)*scale, lerp(ay[i],by[i],k)*scale );
  }
  endShape(CLOSE);
}

// ===== 形状与布局 =====
function drawShape(xs,ys){
  beginShape(); for(let i=0;i<N;i++) vertex(xs[i]*sScale, ys[i]*sScale); endShape(CLOSE);
}
function tileCenter(ix,iy){
  const cx=marginX + tileDiam*(ix+0.5) + GAP*ix;
  const cy=marginY + tileDiam*(iy+0.5) + GAP*iy;
  return {x:cx,y:cy};
}
function computeGridLayout(){
  const tileDiamX=(width -GAP*(COLS-1))/COLS;
  const tileDiamY=(height-GAP*(ROWS-1))/ROWS;
  tileDiam=Math.min(tileDiamX,tileDiamY);
  rTile=(tileDiam/(2*1.4142*0.95))*0.95;
  sScale=rTile/rBase;
  const usedW=COLS*tileDiam+(COLS-1)*GAP;
  const usedH=ROWS*tileDiam+(ROWS-1)*GAP;
  marginX=(width -usedW)*0.5;
  marginY=(height-usedH)*0.5;

  const tl = tileCenter(0,0);
  const br = tileCenter(COLS-1,ROWS-1);
  maxReachDist = dist(tl.x,tl.y, br.x,br.y) + 2*tileDiam + 200;
}

// ===== 多边形重采样 =====
function buildTrianglePoints(outX,outY,n,r){
  const poly=[]; for(let i=0;i<3;i++){ const a=-HALF_PI+TWO_PI*i/3; poly.push({x:r*Math.cos(a),y:r*Math.sin(a)}); }
  poly.push({...poly[0]}); resampleToArrays(poly,n,outX,outY);
}
function buildSquarePoints(outX,outY,n,r){
  const s=r*1.4142*0.95;
  const poly=[{x:-s,y:-s},{x:s,y:-s},{x:s,y:s},{x:-s,y:s},{x:-s,y:-s}];
  resampleToArrays(poly,n,outX,outY);
}
function buildCirclePoints(outX,outY,n,r){
  for(let i=0;i<n;i++){ const a=TWO_PI*i/n; outX[i]=r*Math.cos(a); outY[i]=r*Math.sin(a); }
}
function resampleToArrays(src,n,outX,outY){
  let per=0; for(let i=0;i<src.length-1;i++) per+=vdist(src[i],src[i+1]);
  const step=per/n; let d=0,seg=0; let a={...src[0]}, b={...src[1]};
  for(let i=0;i<n;i++){
    const target=i*step;
    while(seg<src.length-2 && d+vdist(a,b)<target){ d+=vdist(a,b); seg++; a={...src[seg]}; b={...src[seg+1]}; }
    const remain=target-d; const L=vdist(a,b); const t=(L===0)?0:(remain/L); const p=vlerp(a,b,t);
    outX[i]=p.x; outY[i]=p.y;
  }
}
function vdist(p,q){ return Math.hypot(p.x-q.x, p.y-q.y); }
function vlerp(a,b,t){ return {x:lerp(a.x,b.x,t), y:lerp(a.y,b.y,t)}; }
function easeInOutCubic(x){ return (x<0.5)?4*x*x*x:1-Math.pow(-2*x+2,3)/2; }

// ===== 旋钮覆盖层（30–3000ms 线性刻度）=====
function drawKnobOverlay(){
  const c = knob.center;

  // 半透明遮罩
  noStroke(); fill(0, 160); rect(0,0,width,height);

  push();
  translate(c.x, c.y);

  // 外圈
  stroke(255, 220); strokeWeight(3); noFill();
  circle(0, 0, KNOB_RADIUS * 2);

  // 刻度：主刻度 12 个，细分 4
  const major = 12, minorPerMajor = 4;
  const minDeg = -150, maxDeg = 150;

  textAlign(CENTER, CENTER);
  textSize(12);

  // 主刻度与标签
  for (let i = 0; i <= major; i++) {
    const t = i / major;
    const rad = lerp(minDeg, maxDeg, t) * PI / 180;
    const r1 = KNOB_RADIUS - 12, r2 = KNOB_RADIUS;
    stroke(255, 220); strokeWeight(2);
    line(r1 * cos(rad), r1 * sin(rad), r2 * cos(rad), r2 * sin(rad));

    // 只显示间隔的标签，防止拥挤
    if (i % 2 === 0) {
      const ms = Math.round(lerp(HOLD_MIN, HOLD_MAX, t));
      noStroke(); fill(200);
      const tx = (KNOB_RADIUS + 20) * cos(rad);
      const ty = (KNOB_RADIUS + 20) * sin(rad);
      text(ms, tx, ty);
    }
  }

  // 细分刻度
  stroke(255, 140); strokeWeight(1);
  for (let i = 0; i < major; i++) {
    for (let j = 1; j < minorPerMajor; j++) {
      const t = (i + j / minorPerMajor) / major;
      const rad = lerp(minDeg, maxDeg, t) * PI / 180;
      const r1 = KNOB_RADIUS - 8, r2 = KNOB_RADIUS;
      line(r1 * cos(rad), r1 * sin(rad), r2 * cos(rad), r2 * sin(rad));
    }
  }

  // 指针（HOLD_MS → 角度）
  const pointerRad = map(HOLD_MS, HOLD_MIN, HOLD_MAX, minDeg, maxDeg, true) * PI / 180;
  stroke(255); strokeWeight(6);
  line(0, 0, (KNOB_RADIUS - 16) * cos(pointerRad), (KNOB_RADIUS - 16) * sin(pointerRad));
  noStroke(); fill(255, 200); circle(0, 0, 6);

  // 数值读数
  fill(255); textSize(18); text(`HOLD_MS = ${Math.round(HOLD_MS)} ms`, 0, KNOB_RADIUS + 28);
  fill(180); textSize(12); text(`Range: ${HOLD_MIN}–${HOLD_MAX} ms`, 0, KNOB_RADIUS + 46);
  pop();
}

// ===== 桌面鼠标 =====
function mousePressed(){
  if(knob.active){
    // 控制模式下：单击退出
    knob.active = false;
    clockPaused = false;
    return;
  }
  isPointerDown = true; isLongPress = false;
  downAtMs = logicalNow;
  lastPointer = {x:mouseX,y:mouseY};
}
function mouseDragged(){ lastPointer = {x:mouseX,y:mouseY}; }
function mouseMoved(){ if(isPointerDown) lastPointer = {x:mouseX,y:mouseY}; }
function mouseReleased(){ isPointerDown=false; isLongPress=false; }

// ===== 触摸（多指）=====
function touchStarted(){
  if(touches.length >= 2){
    // 进入旋钮控制模式
    enterKnobMode();
    return false;
  }
  if(knob.active && touches.length === 1){
    // 单指点击空白：退出控制模式
    knob.active = false;
    clockPaused = false;
    return false;
  }
  // 普通单指：准备长按
  isPointerDown = true; isLongPress = false;
  downAtMs = logicalNow;
  const t = touches[0] || {x:mouseX,y:mouseY};
  lastPointer = {x:t.x, y:t.y};
  return false;
}

function touchMoved(){
  if(knob.active && touches.length >= 2){
    updateKnobWithPinch();
    return false;
  }
  if(touches.length >= 1){
    const t = touches[0];
    lastPointer = {x:t.x, y:t.y};
  }
  return false;
}

function touchEnded(){
  if(touches.length === 0){
    isPointerDown = false;
    isLongPress = false;
  }
  return false;
}

// ===== 旋钮模式：进入/更新 =====
function enterKnobMode(){
  const p1 = {x: touches[0].x, y: touches[0].y};
  const p2 = {x: touches[1].x, y: touches[1].y};
  knob.center = { x: (p1.x+p2.x)/2, y: (p1.y+p2.y)/2 };
  knob.baseDist = dist(p1.x,p1.y, p2.x,p2.y);
  knob.lastDist = knob.baseDist;
  knob.angle = 0;
  knob.enteredAt = logicalNow;

  knob.active = true;
  clockPaused = true; // 冻结
}

function updateKnobWithPinch(){
  const p1 = {x: touches[0].x, y: touches[0].y};
  const p2 = {x: touches[1].x, y: touches[1].y};
  const center = { x: (p1.x+p2.x)/2, y: (p1.y+p2.y)/2 };
  const curDist = dist(p1.x,p1.y, p2.x,p2.y);

  // 旋钮位置跟随两指中心
  knob.center = center;

  // 捏合（距离变小）→ 逆时针；张开 → 顺时针（仅视觉）
  const delta = curDist - knob.lastDist;
  knob.angle += delta * 0.6;

  // 距离变化 → HOLD_MS（限制到 30–3000ms）
  HOLD_MS = constrain(HOLD_MS + delta * KNOB_SENSITIVITY, HOLD_MIN, HOLD_MAX);

  knob.lastDist = curDist;
}
