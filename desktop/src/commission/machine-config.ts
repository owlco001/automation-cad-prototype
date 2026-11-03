// 机型配置的对外入口。
//
// 校验规则已收敛到 machine/validate.ts（单一校验源）：本文件只保留原有的对外导出面
// （常量、类型、validateMachineConfig）与 demo 机型生成，调用方无需改动。

import {
  DEFAULT_ACTUATOR_TRAVEL_MM,
  DEFAULT_ROTATION_RANGE_DEG,
  assertDesign,
  type ActuatorConfig,
  type MachineConfig,
  type SensorConfig
} from '../machine/validate.ts';

export type { ActuatorConfig, MachineConfig, SensorConfig } from '../machine/validate.ts';

export {
  DEFAULT_ACTUATOR_TRAVEL_MM,
  MIN_ACTUATOR_TRAVEL_MM,
  MAX_ACTUATOR_TRAVEL_MM,
  DEFAULT_ROTATION_RANGE_DEG,
  MIN_ROTATION_RANGE_DEG,
  MAX_ROTATION_RANGE_DEG
} from '../machine/validate.ts';

// 边界说明：STEP 导入结果只包含几何/装配信息，不包含执行机构定义与运动学。
// 本文件描述的是联调原型的“点位 → 执行机构/工位”配置映射，不代表可从任意 STEP
// 自动推导机构类型、行程或轴关系。后续若接入机器人/伺服模型，需要额外的运动学数据源。

/** 校验并归一化机型配置。规则在 machine/validate.ts，这里只做抛错方式的兼容包装。 */
export function validateMachineConfig(value: unknown): MachineConfig {
  return assertDesign(value);
}

export function demoMachineConfig(): MachineConfig {
  const stations = ['上料', '压装', '锁付', '下料'];
  const sensorColors = ['#2dd4bf', '#60a5fa', '#f59e0b', '#a78bfa'];
  const actuators: ActuatorConfig[] = [];
  const sensors: SensorConfig[] = [];

  for (const [index, station] of stations.entries()) {
    const prefix = `station-${index + 1}`;
    const cylinderId = `${prefix}-cylinder`;
    const gripperId = `${prefix}-gripper`;
    const rotaryId = `${prefix}-rotary`;
    actuators.push(
      {
        id: cylinderId,
        name: `${station}气缸`,
        kind: 'cylinder',
        station,
        extendPoint: `Y${index}`,
        retractPoint: `Y${index + 4}`,
        travelMm: DEFAULT_ACTUATOR_TRAVEL_MM,
        durationMs: 400,
        position: [-0.72, 0.55, -0.38]
      },
      {
        id: gripperId,
        name: `${station}夹爪`,
        kind: 'gripper',
        station,
        gripPoint: `Y${index + 8}`,
        durationMs: 280,
        position: [0.05, 0.55, -0.38]
      },
      {
        id: rotaryId,
        name: `${station}旋转台`,
        kind: 'rotary',
        station,
        point: `Y${index + 12}`,
        rotationRangeDeg: DEFAULT_ROTATION_RANGE_DEG,
        durationMs: 520,
        position: [0.76, 0.65, 0.35]
      }
    );

    const parts: [string, string, string, string] = [cylinderId, gripperId, rotaryId, station];
    for (let offset = 0; offset < 4; offset += 1) {
      sensors.push({
        point: `X${index * 4 + offset}`,
        station,
        part: parts[offset] ?? station,
        color: sensorColors[index] ?? '#2dd4bf'
      });
    }
  }

  return validateMachineConfig({
    id: 'demo-4x3',
    name: '4 工位通用联调样机',
    stations,
    actuators,
    sensors
  });
}
