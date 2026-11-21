export function clearanceFixture(count, seed = 42) {
  let state=seed>>>0;
  const random=()=>{state=(1664525*state+1013904223)>>>0;return state/4294967296;};
  return { parts:Array.from({length:count},(_,index)=>({
    id:`st${index%12}-detail-${index}`,name:`part ${index}`,role:'structure',
    shape:index%4===0?{type:'cylinder',radius:3+random()*20,length:10+random()*70,axis:['x','y','z'][index%3]}:{type:'box',size:[5+random()*70,5+random()*70,5+random()*70]},
    center:[(index%25)*45+random()*10,Math.floor(index/25)*45+random()*10,random()*80],rotationZDeg:index%5===0?random()*360:0
  }))};
}
