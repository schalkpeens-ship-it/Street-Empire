const express=require('express'),{Pool}=require('pg'),bcrypt=require('bcryptjs'),session=require('express-session'),rateLimit=require('express-rate-limit');
const app=express(),db=new Pool({connectionString:process.env.DATABASE_URL});
app.set('trust proxy',1);app.use(express.json());
app.use(session({store:new(require('connect-pg-simple')(session))({pool:db,createTableIfMissing:true}),secret:process.env.SESSION_SECRET||require('crypto').randomBytes(32).toString('hex'),resave:false,saveUninitialized:false,cookie:{httpOnly:true,sameSite:'strict',secure:process.env.NODE_ENV==='production'}}));
const defaults={name:'STREET EMPIRE',currency:'R',commission:10,products:['Weed','Meth','Cocaine','MDMA','Shrooms'],salary:500,weekStart:1,utcOffset:120,weekTime:'19:00',washRate:15};
const wrap=f=>(req,res,next)=>Promise.resolve(f(req,res,next)).catch(next);
const boss=(q,r,n)=>q.user.role==='boss'?n():r.sendStatus(403);
app.use('/api/login',rateLimit({windowMs:15*60*1000,max:20,standardHeaders:true,legacyHeaders:false}));
app.post('/api/login',wrap(async(req,res)=>{let u=(await db.query('select * from members where username=$1',[req.body.username])).rows[0];if(!u||!await bcrypt.compare(String(req.body.password),u.password)||u.active===false)return res.sendStatus(401);req.session.regenerate(e=>{if(e)return res.sendStatus(500);req.session.uid=u.id;res.json({ok:true})})}));
app.post('/api/logout',(q,r)=>q.session.destroy(()=>r.json({ok:true})));
app.use('/api',wrap(async(q,r,n)=>{let u=(await db.query('select id,username,role,salary from members where id=$1',[q.session.uid||0])).rows[0];if(!u)return r.sendStatus(401);q.user=u;n()}));

app.get('/api/data',wrap(async(q,r)=>{
  let b=q.user.role==='boss';
  const [settings,entries,members,consumables,vehicles,ammo,busts,fuelLogs,washLogs,recipes,crafts,stock]=await Promise.all([
    db.query('select data from settings where id=1'),
    db.query('select e.*,m.username from entries e join members m on m.id=e.member '+(b?'':'where member=$1 ')+'order by e.id desc',b?[]:[q.user.id]),
    b?db.query('select id,username,role,salary,coalesce(active,true) as active from members order by id'):Promise.resolve({rows:[]}),
    db.query('select c.*,m.username as assigned_to_name from consumables c left join members m on m.id=c.assigned_to order by c.name'),
    db.query('select v.*,m.username as assigned_to_name from vehicles v left join members m on m.id=v.assigned_to order by v.name'),
    db.query('select * from ammo order by ammo_type'),
    b?db.query('select bust.*,m.username as member_name from busts bust left join members m on m.id=bust.member_id order by bust.id desc'):Promise.resolve({rows:[]}),
    db.query('select f.*,v.name as vehicle_name,m.username from fuel_log f left join vehicles v on v.id=f.vehicle_id left join members m on m.id=f.member_id order by f.id desc limit 200'),
    b?db.query('select w.*,m.username from wash_log w left join members m on m.id=w.member_id order by w.id desc'):Promise.resolve({rows:[]}),
    db.query('select r.*,json_agg(json_build_object(\'consumable_id\',ri.consumable_id,\'quantity\',ri.quantity,\'consumable_name\',c.name) order by ri.id) as ingredients from recipes r left join recipe_ingredients ri on ri.recipe_id=r.id left join consumables c on c.id=ri.consumable_id group by r.id order by r.name'),
    db.query('select cr.*,m.username,r.name as recipe_name,r.output_product,r.output_qty from crafts cr join members m on m.id=cr.member_id join recipes r on r.id=cr.recipe_id order by cr.id desc limit 200'),
    db.query('select * from finished_stock order by product_name')
  ]);
  r.json({user:q.user,settings:settings.rows[0].data,entries:entries.rows,members:members.rows,consumables:consumables.rows,vehicles:vehicles.rows,ammo:ammo.rows,busts:busts.rows,fuelLogs:fuelLogs.rows,washLogs:washLogs.rows,recipes:recipes.rows,crafts:crafts.rows,stock:stock.rows});
}));

app.post('/api/entry',wrap(async(q,r)=>{let {type,item,quantity,price}=q.body;let s=(await db.query('select data from settings where id=1')).rows[0].data;if(!['sale','purchase','expense','payroll'].includes(type)||(!['sale','purchase'].includes(type)&&q.user.role!=='boss')||!Number.isInteger(quantity)||quantity<1||!Number.isFinite(price)||price<0||price>1e9||quantity>1e6||typeof item!=='string'||item.length>100||(['sale','purchase'].includes(type)&&!s.products.includes(item)))return r.sendStatus(400);await db.query('insert into entries(member,type,item,quantity,price,commission) values($1,$2,$3,$4,$5,$6)',[q.user.id,type,item,quantity,price,type==='sale'?s.commission:0]);r.json({ok:true})}));
app.post('/api/settings',boss,wrap(async(q,r)=>{
  let s=q.body;
  if(typeof s.weekTime!=='string'||!/^([01]\d|2[0-3]):[0-5]\d$/.test(s.weekTime))return r.sendStatus(400);
  if(!Number.isInteger(s.weekStart)||s.weekStart<0||s.weekStart>6||!Number.isInteger(s.utcOffset)||s.utcOffset<-720||s.utcOffset>840)return r.sendStatus(400);
  if(typeof s.name!=='string'||typeof s.currency!=='string'||!Array.isArray(s.products)||!s.products.every(x=>typeof x==='string'&&x.length<=100)||!Number.isFinite(s.commission)||s.commission<0||s.commission>100||!Number.isFinite(s.salary)||s.salary<0)return r.sendStatus(400);
  if(!Number.isFinite(Number(s.washRate))||Number(s.washRate)<0||Number(s.washRate)>100)return r.sendStatus(400);
  s.washRate=Number(s.washRate);
  await db.query('update settings set data=$1 where id=1',[JSON.stringify(s)]);
  r.json({ok:true});
}));
app.post('/api/member',boss,wrap(async(q,r)=>{let {username,password,role,salary}=q.body;if(!username||typeof password!=='string'||password.length<8||!['boss','staff'].includes(role)||!Number.isFinite(salary)||salary<0)return r.sendStatus(400);await db.query('insert into members(username,password,role,salary) values($1,$2,$3,$4)',[username,await bcrypt.hash(password,12),role,salary]);r.json({ok:true})}));
app.post('/api/member/edit',boss,wrap(async(q,r)=>{const {id,username,salary,role}=q.body;if(!Number.isInteger(id)||id<1||typeof username!=='string'||!username.trim()||username.length>100||!Number.isFinite(salary)||salary<0||salary>1e9||!['boss','staff'].includes(role))return r.sendStatus(400);if(id===q.user.id&&role!=='boss')return r.status(400).json({error:'Cannot demote your own boss account'});try{const result=await db.query('update members set username=$1,salary=$2,role=$3 where id=$4',[username.trim(),salary,role,id]);if(!result.rowCount)return r.sendStatus(404);r.json({ok:true})}catch(e){if(e.code==='23505')return r.status(409).json({error:'Username already exists'});throw e}}));
app.post('/api/member/toggle',boss,wrap(async(q,r)=>{const {id}=q.body;if(!Number.isInteger(id)||id<1)return r.sendStatus(400);if(id===q.user.id)return r.status(400).json({error:'Cannot deactivate your own account'});const result=await db.query('update members set active=not coalesce(active,true) where id=$1 returning active',[id]);if(!result.rowCount)return r.sendStatus(404);r.json({ok:true,active:result.rows[0].active})}));
app.post('/api/member/delete',boss,wrap(async(q,r)=>{const {id}=q.body;if(!Number.isInteger(id)||id<1)return r.sendStatus(400);if(id===q.user.id)return r.status(400).json({error:'Cannot delete your own account'});await db.query('update entries set member=null where member=$1',[id]);const result=await db.query('delete from members where id=$1',[id]);if(!result.rowCount)return r.sendStatus(404);r.json({ok:true})}));
app.post('/api/member/password',wrap(async(q,r)=>{const {current,next}=q.body;if(typeof current!=='string'||typeof next!=='string'||next.length<8)return r.status(400).json({error:'New password must be at least 8 characters'});const u=(await db.query('select password from members where id=$1',[q.user.id])).rows[0];if(!await bcrypt.compare(current,u.password))return r.status(403).json({error:'Current password is incorrect'});await db.query('update members set password=$1 where id=$2',[await bcrypt.hash(next,12),q.user.id]);r.json({ok:true})}));
app.post('/api/member/reset-password',boss,wrap(async(q,r)=>{const {id,password}=q.body;if(!Number.isInteger(id)||id<1||typeof password!=='string'||password.length<8)return r.sendStatus(400);const result=await db.query('update members set password=$1 where id=$2',[await bcrypt.hash(password,12),id]);if(!result.rowCount)return r.sendStatus(404);r.json({ok:true})}));

/* CONSUMABLES */
app.post('/api/consumable',boss,wrap(async(q,r)=>{const{name,cost_per_unit,quantity,assigned_to}=q.body;if(typeof name!=='string'||!name.trim()||name.length>100)return r.sendStatus(400);if(!Number.isFinite(Number(cost_per_unit))||Number(cost_per_unit)<0)return r.sendStatus(400);if(!Number.isInteger(quantity)||quantity<0)return r.sendStatus(400);const asgn=(assigned_to&&Number.isInteger(Number(assigned_to))&&Number(assigned_to)>0)?Number(assigned_to):null;const result=await db.query('insert into consumables(name,cost_per_unit,quantity,assigned_to) values($1,$2,$3,$4) returning *',[name.trim(),Number(cost_per_unit),quantity,asgn]);r.json({ok:true,consumable:result.rows[0]})}));
app.post('/api/consumable/edit',boss,wrap(async(q,r)=>{const{id,name,cost_per_unit,quantity,assigned_to}=q.body;if(!Number.isInteger(id)||id<1)return r.sendStatus(400);if(typeof name!=='string'||!name.trim()||name.length>100)return r.sendStatus(400);if(!Number.isFinite(Number(cost_per_unit))||Number(cost_per_unit)<0)return r.sendStatus(400);if(!Number.isInteger(quantity)||quantity<0)return r.sendStatus(400);const asgn=(assigned_to&&Number.isInteger(Number(assigned_to))&&Number(assigned_to)>0)?Number(assigned_to):null;const result=await db.query('update consumables set name=$1,cost_per_unit=$2,quantity=$3,assigned_to=$4 where id=$5',[name.trim(),Number(cost_per_unit),quantity,asgn,id]);if(!result.rowCount)return r.sendStatus(404);r.json({ok:true})}));
app.post('/api/consumable/delete',boss,wrap(async(q,r)=>{const{id}=q.body;if(!Number.isInteger(id)||id<1)return r.sendStatus(400);const result=await db.query('delete from consumables where id=$1',[id]);if(!result.rowCount)return r.sendStatus(404);r.json({ok:true})}));
app.post('/api/consumable/use',wrap(async(q,r)=>{const{id,amount}=q.body;if(!Number.isInteger(id)||id<1)return r.sendStatus(400);if(!Number.isInteger(amount)||amount<1||amount>1e6)return r.sendStatus(400);const result=await db.query('update consumables set quantity=greatest(0,quantity-$1) where id=$2 returning quantity',[amount,id]);if(!result.rowCount)return r.sendStatus(404);r.json({ok:true,remaining:result.rows[0].quantity})}));

/* VEHICLES */
app.post('/api/vehicle',boss,wrap(async(q,r)=>{const{name,plate,type,assigned_to}=q.body;if(typeof name!=='string'||!name.trim()||name.length>100)return r.sendStatus(400);if(typeof plate!=='string'||plate.length>30)return r.sendStatus(400);if(typeof type!=='string'||type.length>50)return r.sendStatus(400);const asgn=(assigned_to&&Number.isInteger(Number(assigned_to))&&Number(assigned_to)>0)?Number(assigned_to):null;const result=await db.query('insert into vehicles(name,plate,type,status,assigned_to) values($1,$2,$3,$4,$5) returning *',[name.trim(),plate.trim(),type.trim(),'available',asgn]);r.json({ok:true,vehicle:result.rows[0]})}));
app.post('/api/vehicle/edit',boss,wrap(async(q,r)=>{const{id,name,plate,type,status,assigned_to}=q.body;if(!Number.isInteger(id)||id<1)return r.sendStatus(400);if(typeof name!=='string'||!name.trim()||name.length>100)return r.sendStatus(400);if(!['available','in-use','damaged','off-road','seized'].includes(status))return r.sendStatus(400);const asgn=(assigned_to&&Number.isInteger(Number(assigned_to))&&Number(assigned_to)>0)?Number(assigned_to):null;const result=await db.query('update vehicles set name=$1,plate=$2,type=$3,status=$4,assigned_to=$5 where id=$6',[name.trim(),(plate||'').trim(),(type||'').trim(),status,asgn,id]);if(!result.rowCount)return r.sendStatus(404);r.json({ok:true})}));
app.post('/api/vehicle/delete',boss,wrap(async(q,r)=>{const{id}=q.body;if(!Number.isInteger(id)||id<1)return r.sendStatus(400);await db.query('delete from vehicle_service where vehicle_id=$1',[id]);await db.query('delete from fuel_log where vehicle_id=$1',[id]);const result=await db.query('delete from vehicles where id=$1',[id]);if(!result.rowCount)return r.sendStatus(404);r.json({ok:true})}));
app.post('/api/vehicle/service',wrap(async(q,r)=>{const{vehicle_id,note}=q.body;if(!Number.isInteger(Number(vehicle_id))||Number(vehicle_id)<1)return r.sendStatus(400);if(typeof note!=='string'||!note.trim()||note.length>500)return r.sendStatus(400);await db.query('insert into vehicle_service(vehicle_id,member_id,note) values($1,$2,$3)',[Number(vehicle_id),q.user.id,note.trim()]);r.json({ok:true})}));
app.get('/api/vehicle/:id/service',wrap(async(q,r)=>{const id=parseInt(q.params.id);if(!id||id<1)return r.sendStatus(400);const rows=(await db.query('select s.*,m.username from vehicle_service s left join members m on m.id=s.member_id where s.vehicle_id=$1 order by s.id desc',[id])).rows;r.json({logs:rows})}));

/* FUEL */
app.post('/api/fuel',wrap(async(q,r)=>{
  const {vehicle_id,litres,cost_per_litre,notes}=q.body;
  if(!Number.isInteger(Number(vehicle_id))||Number(vehicle_id)<1)return r.sendStatus(400);
  if(!Number.isFinite(Number(litres))||Number(litres)<=0||Number(litres)>5000)return r.sendStatus(400);
  if(!Number.isFinite(Number(cost_per_litre))||Number(cost_per_litre)<0||Number(cost_per_litre)>10000)return r.sendStatus(400);
  const total=Number(litres)*Number(cost_per_litre);
  const vid=Number(vehicle_id),lit=Number(litres),cpl=Number(cost_per_litre);
  const n=(notes&&typeof notes==='string')?notes.trim().slice(0,300):'';
  await db.query('insert into fuel_log(vehicle_id,member_id,litres,cost_per_litre,total_cost,notes) values($1,$2,$3,$4,$5,$6)',[vid,q.user.id,lit,cpl,total,n]);
  const vname=(await db.query('select name from vehicles where id=$1',[vid])).rows[0];
  await db.query('insert into entries(member,type,item,quantity,price,commission) values($1,$2,$3,$4,$5,$6)',
    [q.user.id,'expense','Fuel – '+(vname?vname.name:'Vehicle'),1,total,0]);
  r.json({ok:true,total:total});
}));

/* WASH */
app.post('/api/wash',boss,wrap(async(q,r)=>{
  const {dirty_amount,wash_rate,notes}=q.body;
  if(!Number.isFinite(Number(dirty_amount))||Number(dirty_amount)<=0)return r.sendStatus(400);
  if(!Number.isFinite(Number(wash_rate))||Number(wash_rate)<0||Number(wash_rate)>100)return r.sendStatus(400);
  const dirty=Number(dirty_amount),rate=Number(wash_rate);
  const fee=Math.round(dirty*rate)/100;
  const clean=dirty-fee;
  const n=(notes&&typeof notes==='string')?notes.trim().slice(0,300):'';
  await db.query('insert into wash_log(member_id,dirty_amount,wash_rate,fee,clean_amount,notes) values($1,$2,$3,$4,$5,$6)',[q.user.id,dirty,rate,fee,clean,n]);
  await db.query('insert into entries(member,type,item,quantity,price,commission) values($1,$2,$3,$4,$5,$6)',
    [q.user.id,'expense','Wash Fee ('+rate+'%)',1,fee,0]);
  r.json({ok:true,fee,clean});
}));

/* AMMO */
app.post('/api/ammo',boss,wrap(async(q,r)=>{const{ammo_type,rounds}=q.body;if(typeof ammo_type!=='string'||!ammo_type.trim()||ammo_type.length>100)return r.sendStatus(400);if(!Number.isInteger(rounds)||rounds<0)return r.sendStatus(400);const result=await db.query('insert into ammo(ammo_type,rounds) values($1,$2) on conflict(ammo_type) do update set rounds=ammo.rounds+excluded.rounds returning *',[ammo_type.trim(),rounds]);r.json({ok:true,ammo:result.rows[0]})}));
app.post('/api/ammo/use',boss,wrap(async(q,r)=>{const{id,amount,reason}=q.body;if(!Number.isInteger(id)||id<1)return r.sendStatus(400);if(!Number.isInteger(amount)||amount<1||amount>1e7)return r.sendStatus(400);const rsn=(reason&&typeof reason==='string')?reason.trim().slice(0,200):'Used';const result=await db.query('update ammo set rounds=greatest(0,rounds-$1) where id=$2 returning rounds',[amount,id]);if(!result.rowCount)return r.sendStatus(404);await db.query('insert into ammo_log(ammo_id,member_id,change,reason) values($1,$2,$3,$4)',[id,q.user.id,-amount,rsn]);r.json({ok:true,remaining:result.rows[0].rounds})}));
app.post('/api/ammo/seize',boss,wrap(async(q,r)=>{const{id,amount,reason}=q.body;if(!Number.isInteger(id)||id<1)return r.sendStatus(400);if(!Number.isInteger(amount)||amount<1||amount>1e7)return r.sendStatus(400);const rsn=(reason&&typeof reason==='string')?reason.trim().slice(0,200):'Seized/Destroyed';const result=await db.query('update ammo set rounds=greatest(0,rounds-$1) where id=$2 returning rounds',[amount,id]);if(!result.rowCount)return r.sendStatus(404);await db.query('insert into ammo_log(ammo_id,member_id,change,reason) values($1,$2,$3,$4)',[id,q.user.id,-amount,rsn]);r.json({ok:true,remaining:result.rows[0].rounds})}));
app.post('/api/ammo/delete',boss,wrap(async(q,r)=>{const{id}=q.body;if(!Number.isInteger(id)||id<1)return r.sendStatus(400);await db.query('delete from ammo_log where ammo_id=$1',[id]);const result=await db.query('delete from ammo where id=$1',[id]);if(!result.rowCount)return r.sendStatus(404);r.json({ok:true})}));
app.get('/api/ammo/:id/log',boss,wrap(async(q,r)=>{const id=parseInt(q.params.id);if(!id||id<1)return r.sendStatus(400);const rows=(await db.query('select l.*,m.username from ammo_log l left join members m on m.id=l.member_id where l.ammo_id=$1 order by l.id desc limit 50',[id])).rows;r.json({logs:rows})}));

/* BUSTS */
app.post('/api/bust',boss,wrap(async(q,r)=>{
  const {member_id,charges,fine,seized_cash,seized_product,notes,seized_weapon_ids,seized_vehicle_ids}=q.body;
  if(!Number.isInteger(member_id)||member_id<1)return r.sendStatus(400);
  if(typeof charges!=='string'||!charges.trim())return r.sendStatus(400);
  const fineAmt=Number(fine)||0,cashAmt=Number(seized_cash)||0;
  const result=await db.query('insert into busts(member_id,charges,fine,seized_cash,seized_product,notes) values($1,$2,$3,$4,$5,$6) returning id',[member_id,charges.trim().slice(0,500),fineAmt,cashAmt,(seized_product||'').trim().slice(0,500),(notes||'').trim().slice(0,500)]);
  const bustId=result.rows[0].id;
  await db.query('update members set active=false where id=$1',[member_id]);
  if(Array.isArray(seized_weapon_ids)&&seized_weapon_ids.length){for(const wid of seized_weapon_ids){if(Number.isInteger(Number(wid))&&Number(wid)>0)await db.query('update ammo set rounds=0 where id=$1',[Number(wid)]);}}
  if(Array.isArray(seized_vehicle_ids)&&seized_vehicle_ids.length){for(const vid of seized_vehicle_ids){if(Number.isInteger(Number(vid))&&Number(vid)>0)await db.query('update vehicles set status=$1 where id=$2',['seized',Number(vid)]);}}
  if(fineAmt>0)await db.query('insert into entries(member,type,item,quantity,price,commission) values($1,$2,$3,$4,$5,$6)',[q.user.id,'expense','Legal/Fine – Bust #'+bustId,1,fineAmt,0]);
  r.json({ok:true,bust_id:bustId});
}));
app.post('/api/bust/reinstate',boss,wrap(async(q,r)=>{const{bust_id}=q.body;if(!Number.isInteger(bust_id)||bust_id<1)return r.sendStatus(400);const bust=(await db.query('select member_id from busts where id=$1',[bust_id])).rows[0];if(!bust)return r.sendStatus(404);await db.query('update members set active=true where id=$1',[bust.member_id]);await db.query('update busts set reinstated=true where id=$1',[bust_id]);r.json({ok:true})}));

/* RECIPES */
app.post('/api/recipe',boss,wrap(async(q,r)=>{
  const {name,output_product,output_qty,ingredients}=q.body;
  if(typeof name!=='string'||!name.trim()||name.length>100)return r.sendStatus(400);
  if(typeof output_product!=='string'||!output_product.trim()||output_product.length>100)return r.sendStatus(400);
  if(!Number.isInteger(output_qty)||output_qty<1)return r.sendStatus(400);
  if(!Array.isArray(ingredients)||!ingredients.length)return r.sendStatus(400);
  for(const ing of ingredients){if(!Number.isInteger(Number(ing.consumable_id))||Number(ing.consumable_id)<1||!Number.isFinite(Number(ing.quantity))||Number(ing.quantity)<=0)return r.sendStatus(400);}
  const rec=await db.query('insert into recipes(name,output_product,output_qty) values($1,$2,$3) returning id',[name.trim(),output_product.trim(),output_qty]);
  const rid=rec.rows[0].id;
  for(const ing of ingredients)await db.query('insert into recipe_ingredients(recipe_id,consumable_id,quantity) values($1,$2,$3)',[rid,Number(ing.consumable_id),Number(ing.quantity)]);
  r.json({ok:true,id:rid});
}));
app.post('/api/recipe/edit',boss,wrap(async(q,r)=>{
  const {id,name,output_product,output_qty,ingredients}=q.body;
  if(!Number.isInteger(id)||id<1)return r.sendStatus(400);
  if(typeof name!=='string'||!name.trim()||name.length>100)return r.sendStatus(400);
  if(typeof output_product!=='string'||!output_product.trim()||output_product.length>100)return r.sendStatus(400);
  if(!Number.isInteger(output_qty)||output_qty<1)return r.sendStatus(400);
  if(!Array.isArray(ingredients)||!ingredients.length)return r.sendStatus(400);
  for(const ing of ingredients){if(!Number.isInteger(Number(ing.consumable_id))||Number(ing.consumable_id)<1||!Number.isFinite(Number(ing.quantity))||Number(ing.quantity)<=0)return r.sendStatus(400);}
  await db.query('update recipes set name=$1,output_product=$2,output_qty=$3 where id=$4',[name.trim(),output_product.trim(),output_qty,id]);
  await db.query('delete from recipe_ingredients where recipe_id=$1',[id]);
  for(const ing of ingredients)await db.query('insert into recipe_ingredients(recipe_id,consumable_id,quantity) values($1,$2,$3)',[id,Number(ing.consumable_id),Number(ing.quantity)]);
  r.json({ok:true});
}));
app.post('/api/recipe/delete',boss,wrap(async(q,r)=>{
  const {id}=q.body;if(!Number.isInteger(id)||id<1)return r.sendStatus(400);
  await db.query('delete from recipe_ingredients where recipe_id=$1',[id]);
  const res=await db.query('delete from recipes where id=$1',[id]);
  if(!res.rowCount)return r.sendStatus(404);r.json({ok:true});
}));

/* CRAFT */
app.post('/api/craft',wrap(async(q,r)=>{
  const {recipe_id,batches}=q.body;
  if(!Number.isInteger(Number(recipe_id))||Number(recipe_id)<1)return r.sendStatus(400);
  if(!Number.isInteger(batches)||batches<1||batches>10000)return r.sendStatus(400);
  const rid=Number(recipe_id);
  const rec=(await db.query('select r.*,json_agg(json_build_object(\'consumable_id\',ri.consumable_id,\'quantity\',ri.quantity,\'name\',c.name,\'stock\',c.quantity)) as ingredients from recipes r join recipe_ingredients ri on ri.recipe_id=r.id join consumables c on c.id=ri.consumable_id where r.id=$1 group by r.id',[rid])).rows[0];
  if(!rec)return r.sendStatus(404);
  // Check stock
  for(const ing of rec.ingredients){
    const needed=Number(ing.quantity)*batches;
    if(Number(ing.stock)<needed)return r.status(409).json({error:'Not enough '+ing.name+' (need '+needed+', have '+Number(ing.stock)+')'});
  }
  // Deduct consumables
  for(const ing of rec.ingredients)await db.query('update consumables set quantity=quantity-$1 where id=$2',[Number(ing.quantity)*batches,ing.consumable_id]);
  // Add to finished stock
  const totalOut=rec.output_qty*batches;
  await db.query('insert into finished_stock(product_name,quantity) values($1,$2) on conflict(product_name) do update set quantity=finished_stock.quantity+excluded.quantity',[rec.output_product,totalOut]);
  // Log craft record
  await db.query('insert into crafts(member_id,recipe_id,batches,total_output) values($1,$2,$3,$4)',[q.user.id,rid,batches,totalOut]);
  r.json({ok:true,total_output:totalOut,product:rec.output_product});
}));

/* FINISHED STOCK */
app.post('/api/stock/adjust',boss,wrap(async(q,r)=>{
  const {product_name,adjustment,reason}=q.body;
  if(typeof product_name!=='string'||!product_name.trim())return r.sendStatus(400);
  if(!Number.isInteger(adjustment))return r.sendStatus(400);
  const rsn=(reason&&typeof reason==='string')?reason.trim().slice(0,200):'Manual adjustment';
  await db.query('insert into finished_stock(product_name,quantity) values($1,$2) on conflict(product_name) do update set quantity=greatest(0,finished_stock.quantity+excluded.quantity)',[product_name.trim(),adjustment]);
  r.json({ok:true});
}));
app.post('/api/stock/sell',boss,wrap(async(q,r)=>{
  const {product_name,quantity,price_per_unit}=q.body;
  if(typeof product_name!=='string'||!product_name.trim())return r.sendStatus(400);
  if(!Number.isInteger(quantity)||quantity<1)return r.sendStatus(400);
  if(!Number.isFinite(Number(price_per_unit))||Number(price_per_unit)<0)return r.sendStatus(400);
  const stock=(await db.query('select quantity from finished_stock where product_name=$1',[product_name.trim()])).rows[0];
  if(!stock||Number(stock.quantity)<quantity)return r.status(409).json({error:'Not enough stock (have '+(stock?stock.quantity:0)+')'});
  await db.query('update finished_stock set quantity=quantity-$1 where product_name=$2',[quantity,product_name.trim()]);
  const s=(await db.query('select data from settings where id=1')).rows[0].data;
  await db.query('insert into entries(member,type,item,quantity,price,commission) values($1,$2,$3,$4,$5,$6)',[q.user.id,'sale',product_name.trim(),quantity,Number(price_per_unit),s.commission||0]);
  r.json({ok:true});
}));

app.use(express.static('public'));
app.use((e,q,r,n)=>{console.error(e.message);r.status(500).json({error:'Request failed'})});
(async()=>{
  await db.query(`
    create table if not exists members(id serial primary key,username text unique not null,password text not null,role text not null,salary numeric not null);
    create table if not exists settings(id int primary key,data jsonb not null);
    create table if not exists entries(id serial primary key,member int references members(id) on delete set null,type text,item text,quantity int,price numeric,commission numeric,created timestamptz default now());
    alter table members add column if not exists active boolean not null default true;
    create table if not exists consumables(id serial primary key,name text not null,cost_per_unit numeric not null default 0,quantity int not null default 0,assigned_to int references members(id) on delete set null,created timestamptz default now());
    create table if not exists vehicles(id serial primary key,name text not null,plate text,type text,status text not null default 'available',assigned_to int references members(id) on delete set null,created timestamptz default now());
    create table if not exists vehicle_service(id serial primary key,vehicle_id int references vehicles(id) on delete cascade,member_id int references members(id) on delete set null,note text,created timestamptz default now());
    create table if not exists ammo(id serial primary key,ammo_type text unique not null,rounds int not null default 0,created timestamptz default now());
    create table if not exists ammo_log(id serial primary key,ammo_id int references ammo(id) on delete cascade,member_id int references members(id) on delete set null,change int not null,reason text,created timestamptz default now());
    create table if not exists busts(id serial primary key,member_id int references members(id) on delete set null,charges text,fine numeric not null default 0,seized_cash numeric not null default 0,seized_product text,notes text,reinstated boolean not null default false,created timestamptz default now());
    create table if not exists fuel_log(id serial primary key,vehicle_id int references vehicles(id) on delete cascade,member_id int references members(id) on delete set null,litres numeric not null,cost_per_litre numeric not null,total_cost numeric not null,notes text,created timestamptz default now());
    create table if not exists wash_log(id serial primary key,member_id int references members(id) on delete set null,dirty_amount numeric not null,wash_rate numeric not null,fee numeric not null,clean_amount numeric not null,notes text,created timestamptz default now());
    create table if not exists recipes(id serial primary key,name text not null,output_product text not null,output_qty int not null default 1,created timestamptz default now());
    create table if not exists recipe_ingredients(id serial primary key,recipe_id int references recipes(id) on delete cascade,consumable_id int references consumables(id) on delete cascade,quantity numeric not null);
    create table if not exists crafts(id serial primary key,member_id int references members(id) on delete set null,recipe_id int references recipes(id) on delete set null,batches int not null,total_output int not null,created timestamptz default now());
    create table if not exists finished_stock(id serial primary key,product_name text unique not null,quantity int not null default 0,created timestamptz default now());
  `);
  await db.query('insert into settings values(1,$1) on conflict do nothing',[JSON.stringify(defaults)]);
  if(!(await db.query('select id from members limit 1')).rowCount){
    if(!process.env.ADMIN_PASSWORD||process.env.ADMIN_PASSWORD.length<12)throw Error('Set ADMIN_PASSWORD (12+ characters)');
    await db.query('insert into members(username,password,role,salary) values($1,$2,$3,0)',[process.env.ADMIN_USERNAME||'admin',await bcrypt.hash(process.env.ADMIN_PASSWORD,12),'boss']);
  }
  app.listen(process.env.PORT||8080,'0.0.0.0');
  console.log('Street Empire RP running');
})().catch(e=>{console.error(e);process.exit(1)});
