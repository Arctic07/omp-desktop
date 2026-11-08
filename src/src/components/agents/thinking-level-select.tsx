import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/motion/select";
import { THINKING_LEVELS } from "@/lib/thinking-levels";
import { cn } from "@/lib/utils";

export interface ThinkingLevelSelectProps {
  /** Visible field name rendered beside the selected value. */
  label: string;
  value: string;
  onValueChange: (value: string) => void;
  disabled?: boolean;
  className?: string;
  triggerClassName?: string;
}

export function ThinkingLevelSelect({
  label,
  value,
  onValueChange,
  disabled = false,
  className,
  triggerClassName,
}: ThinkingLevelSelectProps) {
  return (
    <Select
      value={value}
      onValueChange={onValueChange}
      disabled={disabled}
      className={cn("min-w-0", className)}
    >
      <SelectTrigger
        className={cn(
          "h-8 w-full min-w-0 gap-1 rounded-xl px-2 py-0 text-xs",
          triggerClassName,
        )}
      >
        <span className="min-w-0 shrink-0 truncate text-muted-foreground">
          {label}
        </span>
        <SelectValue className="min-w-0 truncate" />
      </SelectTrigger>
      <SelectContent className="w-full">
        {THINKING_LEVELS.map((level) => (
          <SelectItem key={level} value={level}>
            {level}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
