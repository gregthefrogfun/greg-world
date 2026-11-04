// "Fly Eyes 360": a cube map rendered from the fly, unwrapped to ~340 degrees and viewed through a hexagonal
// compound-eye mosaic (two eyes, dark divide, lower resolution toward the rear). Only renders while active.
export function createEyes(world, flies) {
  const THREE = world.THREE, renderer = world.renderer, scene = world.scene;
  let size = world.isLowQuality() ? 192 : 384, rt = null, cubeCam = null, on = false, k = 0, frame = 0;
  function ensure() { if (rt && rt.width === size) return; rt?.dispose(); rt = new THREE.WebGLCubeRenderTarget(size, { generateMipmaps: false }); cubeCam = new THREE.CubeCamera(0.012, 260, rt); scene.add(cubeCam); mat.uniforms.uCube.value = rt.texture; }
  const mat = new THREE.ShaderMaterial({
    uniforms: { uCube: { value: null }, uYaw: { value: 0 }, uPitch: { value: 0 }, uK: { value: 0 }, uAspect: { value: 1 }, uTime: { value: 0 } },
    vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0., 1.); }`,
    fragmentShader: `uniform samplerCube uCube; uniform float uYaw, uPitch, uK, uAspect, uTime; varying vec2 vUv;
      vec2 hexCell(vec2 p, float s){ vec2 r = vec2(1., 1.7320508); vec2 h = r*.5; vec2 a = mod(p*s, r)-h; vec2 b = mod(p*s-h, r)-h; vec2 g = dot(a,a)<dot(b,b)?a:b; return (p*s - g)/s; }
      void main(){
        vec2 uv = vUv*2.-1.; uv.x *= uAspect;
        float side = sign(uv.x); float rear = abs(uv.x)/uAspect; // 0 front .. 1 rear
        float cells = mix(90., 46., rear); vec2 c = hexCell(uv, cells); vec2 d = (uv - c)*cells;
        float lon = (c.x/uAspect) * radians(170.) * uK + 0.; float lat = c.y * radians(62.) * mix(1., 1.25, uK);
        float yaw = uYaw + lon, pitch = uPitch + lat;
        vec3 dir = vec3(-sin(yaw)*cos(pitch), sin(pitch), -cos(yaw)*cos(pitch));
        vec3 col = textureCube(uCube, dir).rgb;
        float edge = smoothstep(.32, .62, length(d)); col *= 1. - edge*.45*uK; col = mix(col, col*vec3(1.05,.98,1.08), uK);
        float divide = smoothstep(.012, .0, abs(uv.x)) * uK; col *= 1. - divide*.85;
        col *= 1. - smoothstep(.75, 1.15, rear)*.35*uK;
        gl_FragColor = vec4(col, smoothstep(0., 1., uK));
      }`,
    depthTest: false, depthWrite: false, transparent: true,
  });
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat); const qs = new THREE.Scene(); qs.add(quad); const qc = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  function render(r, sc, cam) {
    k += ((on ? 1 : 0) - k) * 0.12; if (!on && k < 0.02) { world.setRenderOverride(null); r.render(sc, cam); return; }
    ensure(); frame++;
    if (world.fps() < 35 && size > 128) { size = Math.max(128, size / 2); ensure(); }
    if (!world.isLowQuality() || frame % 2 === 0) { const st = flies.state; cubeCam.position.copy(cam.position); cam.visible = false; const fpv = cam.children; fpv.forEach((c) => (c.visible = false)); cubeCam.update(r, sc); fpv.forEach((c) => (c.visible = true)); }
    const e = new THREE.Euler().setFromQuaternion(cam.quaternion, "YXZ");
    mat.uniforms.uYaw.value = e.y; mat.uniforms.uPitch.value = e.x; mat.uniforms.uK.value = k; mat.uniforms.uAspect.value = r.domElement.clientWidth / Math.max(1, r.domElement.clientHeight);
    if (k < 0.98) { r.render(sc, cam); r.autoClear = false; } r.render(qs, qc); r.autoClear = true;
  }
  return { toggle: () => { on = !on; if (on) world.setRenderOverride(render); document.body.classList.toggle("flyeyes", on); }, isOn: () => on };
}
