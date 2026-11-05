// 自动生成，请勿手工修改
// 机型: 旧机型-显式步序 (legacy-explicit)  版本: 2  输入哈希: e6e22c04ee21
// 来源: AutomationCAD 生成器 v1.0.0
// 文件: FC_AutoSequence.st

FUNCTION FC_AutoSequence : VOID
VAR_INPUT
    Start : BOOL;
    Abort : BOOL;
    SafeStop : BOOL;
END_VAR
VAR_OUTPUT
    StepNo : INT;
    SeqTimeout : BOOL;
    StepErrorCode : WORD;
END_VAR
VAR_IN_OUT
    AlarmWord : WORD;
END_VAR
VAR
    _StepTimer : TON;
    _AbortEdge : R_TRIG;
END_VAR
VAR CONSTANT
    STEP_IDLE : INT := 0;
    STEP_ERROR : INT := 99;
    ALARM_SEQ_TIMEOUT : WORD := 16#8101;
END_VAR

_AbortEdge(CLK := Abort);

// 中止或安全停止均回到 Step0，空步只保留待机状态。
IF _AbortEdge.Q OR SafeStop THEN
    StepNo := STEP_IDLE;
    SeqTimeout := FALSE;
    StepErrorCode := 16#0000;
    _StepTimer(IN := FALSE, PT := T#5s);
END_IF;

CASE StepNo OF
    STEP_IDLE:
        // 待机：所有输出复位，等待启动。
        "DB_IO".上料_上料气缸_伸出 := FALSE;
        "DB_IO".上料_上料气缸_缩回 := FALSE;
        "DB_IO".压装_压装夹爪_夹紧 := FALSE;
        SeqTimeout := FALSE;
        StepErrorCode := 16#0000;
        _StepTimer(IN := FALSE, PT := T#5s);
        IF Start AND NOT SafeStop AND NOT Abort THEN
            StepNo := 1;
            _StepTimer(IN := FALSE, PT := T#5s);
        END_IF;

    1:
        // 上料伸出
        "DB_IO".上料_上料气缸_伸出 := TRUE;
        _StepTimer(IN := TRUE, PT := T#1200ms);
        IF "DB_IO".上料_上料气缸_到位 THEN
            StepNo := 2;
            _StepTimer(IN := FALSE, PT := T#5s);
        ELSIF _StepTimer.Q THEN
            StepNo := STEP_ERROR;
            SeqTimeout := TRUE;
            StepErrorCode := 16#8101;
            AlarmWord := AlarmWord OR ALARM_SEQ_TIMEOUT;
            _StepTimer(IN := FALSE, PT := T#5s);
        END_IF;

    2:
        // 压装夹紧
        "DB_IO".压装_压装夹爪_夹紧 := TRUE;
        _StepTimer(IN := TRUE, PT := T#1200ms);
        IF "DB_IO".压装_压装夹爪_到位 THEN
            StepNo := 3;
            _StepTimer(IN := FALSE, PT := T#5s);
        ELSIF _StepTimer.Q THEN
            StepNo := STEP_ERROR;
            SeqTimeout := TRUE;
            StepErrorCode := 16#8101;
            AlarmWord := AlarmWord OR ALARM_SEQ_TIMEOUT;
            _StepTimer(IN := FALSE, PT := T#5s);
        END_IF;

    3:
        // 上料缩回
        "DB_IO".上料_上料气缸_缩回 := TRUE;
        _StepTimer(IN := TRUE, PT := T#1200ms);
        IF "DB_IO".上料_上料气缸_到位_2 THEN
            StepNo := 0;
            _StepTimer(IN := FALSE, PT := T#5s);
        ELSIF _StepTimer.Q THEN
            StepNo := STEP_ERROR;
            SeqTimeout := TRUE;
            StepErrorCode := 16#8101;
            AlarmWord := AlarmWord OR ALARM_SEQ_TIMEOUT;
            _StepTimer(IN := FALSE, PT := T#5s);
        END_IF;

    STEP_ERROR:
        // StepError：超时锁存，报警字已写入，等待 Abort 复位。
        SeqTimeout := TRUE;
        "DB_IO".上料_上料气缸_伸出 := FALSE;
        "DB_IO".上料_上料气缸_缩回 := FALSE;
        "DB_IO".压装_压装夹爪_夹紧 := FALSE;
    ELSE
        StepNo := STEP_ERROR;
        SeqTimeout := TRUE;
END_CASE;
