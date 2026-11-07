# 数据库索引：照着点一遍就行（约 5 分钟）

> 不建也能跑，但绑定表以后会涨到几千行，没索引时每次同步都要全表扫描，到时候变慢就不好排查。
> **建完立即生效，不用重新部署云函数、不用重启小程序、不用清缓存。**

> **先看已有列表，再动手。** 微信的规则是「同一组字段只能有一条索引」，**跟索引名无关**。
> 11-07 实测：`class_courses` 里 `orgId + courseId` 早就建好了（控制台自动命名为 `orgId_courseId`），
> 再建一条叫 `org_course` 的就会报 `IndexOptionsConflict`。**名字不重要，字段组合对上就算完成。**

## 一、进到索引管理页面

1. 打开微信开发者工具 → 顶部工具栏点 **云开发**
2. 左侧选 **数据库**
3. 集合列表里点 **`class_courses`**（班级-课程开设关系表）
4. 右侧上方切到 **索引管理** 标签页
5. 点 **新建索引**（有的版本叫「添加索引」）

## 二、先核对已有索引（这一步别跳过）

在「索引管理」列表里逐条看 **字段** 那一列，对照下面五组目标字段：

| 集合 | 需要的字段组合 | 常见已有名字 |
|---|---|---|
| `class_courses` | `orgId` + `clsId` | `class_courses`、`orgId_clsId` |
| `class_courses` | `orgId` + `courseId` | `orgId_courseId` |
| `class_courses` | `orgId` + `srvAt` | `org_srv` |
| `records` | `orgId` + `srvAt` | `org_srv` |
| `students` | `orgId` + `srvAt` | `org_srv` |

**已经有的就跳过，缺哪组建哪组。** 前两组是必须的，后三条是建议（不建也能跑）。
不同集合可以用同一个索引名，互不冲突。

> 判断标准是**字段组合**，不是名字：看到 `orgId, courseId` 就够了，
> 哪怕它叫 `abc`、`class_courses` 或任何别的名字，都等于这条已经建好。

## 三、一条复合索引怎么填

| 要填的 | 填什么 |
|---|---|
| 索引名称 | 随便起，纯英文小写 + 下划线（如 `org_cls`），别用中文空格 |
| 字段 1 | `orgId`，排序 **升序** |
| 字段 2 | `clsId` / `courseId` / `srvAt`，排序 **升序** |
| 是否唯一 | **否**（一定要选否） |

**复合索引 = 两个字段在同一条索引里**：先填 `orgId`，点「**添加字段**」再加第二行，
两个都填完再确定。别建成两条单字段索引，那对按班级查排课没用。

**为什么必须选「非唯一」**：一个班有多门课、一门课会开在多个班，
`orgId + clsId` 这个组合本来就会重复；选了唯一索引，第二条排课就写不进去了。
这是这步最容易点错的地方。

## 四、建完怎么确认

索引管理列表里能看到目标字段组合即可。
去小程序 **我的 → 存储空间 → 立即同步**，同步能正常完成、没有报错，就算好了。
数据量小时感觉不到变化，收益在几千行之后。

## 五、报错对照

| 提示 | 原因 / 怎么办 |
|---|---|
| `ResourceUnavailable.IndexOptionsConflict`<br>「索引对应的字段已经存在」 | **这条已经建好了**，直接跳过，不用再建。<br>**不要按报错里 `drop it before creating` 去删已有索引** —— 那是数据库的通用提示，删了再建同一组字段没有任何收益，删的过程中查询还会变慢。 |
| 「索引已存在」 | 同上，列表里能看到就行 |
| 「名称不合法」 | 索引名换成纯英文小写 + 下划线，别带空格中文 |
| 「字段不存在」 | 字段名严格照抄 `orgId` / `clsId` / `courseId` / `srvAt`，大小写不能错 |
| 建完感觉没变化 | 正常的，数据量小看不出差别 |

### 11-07 实际遇到的一条

```
[tcb/UpdateTable][ResourceUnavailable.IndexOptionsConflict] 索引对应的字段已经存在
index "orgId_courseId" already exists on the same keys,
drop it before creating index "org_course"
```

含义：`class_courses` 里 `orgId + courseId` 已存在（叫 `orgId_courseId`），
我文档里建议的 `org_course` 只是另一个名字，**同一组字段不需要第二条**。
另一个报错里的 `index "class_courses" already exists on the same keys` 同理。
**数据库没有做任何改动，功能没有受影响**，把这两条当作「已完成」划掉即可。

## 六、为什么这件事只能人工点

微信云开发的**索引管理没有开放给 CLI 或云函数的接口**：
命令行能部署云函数（`npm run cloud`）、能自动建集合（`syncv2.ensureCollections()`），
但建索引、查索引都没有对应 API。所以只能控制台点一次，点完一劳永逸。
也正因如此，「已有索引有哪些」没法从命令行核实，只能看列表或截图。
