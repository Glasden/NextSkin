import type { Meta, StoryObj } from '@storybook/react-vite'
import { Alert } from '../alert/alert.tsx'
import { Button } from '../button/button.tsx'
import { Checkbox } from '../checkbox/checkbox.tsx'
import { Field } from '../field/field.tsx'
import { Form } from '../form/form.tsx'
import { Input } from '../input/input.tsx'
import { Link } from '../link/link.tsx'
import { Logo } from '../logo/logo.tsx'

// 组合示例：检查组件放在一起时的间距和层次，不是页面实现
const meta = {
  title: 'Patterns/Login form',
} satisfies Meta

export default meta
type Story = StoryObj<typeof meta>

function LoginForm({ failed = false }: { failed?: boolean }) {
  return (
    <div className="flex w-96 flex-col gap-8">
      <Logo name="NextSkin" />
      <Form>
        {failed && (
          <Alert tone="danger" title="登录失败">
            邮箱或密码不对。再试一次，或者找回密码。
          </Alert>
        )}
        <Field label="邮箱" name="email">
          <Input type="email" autoComplete="email" required defaultValue={failed ? 'steve@example.com' : ''} />
        </Field>
        <Field label="密码" name="password">
          <Input type="password" autoComplete="current-password" required />
        </Field>
        <div className="flex items-center justify-between">
          <Checkbox name="remember">记住我</Checkbox>
          <Link href="#forgot">忘记密码</Link>
        </div>
        <Button type="submit" variant="primary" size="lg" fullWidth>
          登录
        </Button>
      </Form>
    </div>
  )
}

export const Default: Story = { render: () => <LoginForm /> }

export const Failed: Story = { render: () => <LoginForm failed /> }
