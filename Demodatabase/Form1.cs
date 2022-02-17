using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Data;
using System.Drawing;
using System.Linq;
using System.Text;
using System.Threading.Tasks;
using System.Windows.Forms;
using MySql.Data.MySqlClient;


namespace Demodatabase
{
    public partial class Form1 : Form
    {

        MySqlConnection cnn;
        string connetionString = @"Data Source=localhost;Initial Catalog=movie_review_website;User ID=root;Password=rootroot";

        public Form1()
        {
            InitializeComponent();
        }
        private void Form1_Load(object sender, EventArgs e)
        {



        }

        private void button1_Click(object sender, EventArgs e)
        {
            string connetionString;
            MySqlConnection cnn;
            connetionString = @"Data Source=localhost;Initial Catalog=movie_review_website;User ID=root;Password=rootroot";
            cnn = new MySqlConnection(connetionString);
            cnn.Open();

            MySqlCommand command;
            MySqlDataReader datareader;
            String sql, Output = "";

            sql = "select * from actor";

            command = new MySqlCommand(sql, cnn);

            datareader = command.ExecuteReader();

            while (datareader.Read())
            {
                Output = Output + datareader.GetValue(0) + " - " + " - " + datareader.GetValue(1) + "\n";
            }



            MessageBox.Show(Output);

            datareader.Close();
            command.Dispose();
            cnn.Close();
        }


        private void button2_Click(object sender, EventArgs e)
        {
            string connectionString;
            string actor_name = textBox1.Text;
            MySqlConnection cnn;
            connectionString = @"Data Source=localhost;Initial Catalog=movie_review_website;User ID=root;Password=rootroot";
            cnn = new MySqlConnection(connectionString);
            cnn.Open();
            MySqlCommand command;
            MySqlDataAdapter adapter = new MySqlDataAdapter();
            String sql = "";
            sql = "Insert into actor (actor_name) values (\""+actor_name+"\")";
            command = new MySqlCommand(sql, cnn);
            adapter.InsertCommand = new MySqlCommand(sql, cnn);
            adapter.InsertCommand.ExecuteNonQuery();
            command.Dispose();
            cnn.Close();
        }

        private void button3_Click(object sender, EventArgs e)
        {
            MySqlCommand command;
            MySqlDataAdapter adapter = new MySqlDataAdapter();
            String sql = " ";
            MySqlConnection cnn;
            string connetionString = @"Data Source=localhost;Initial Catalog=movie_review_website;User ID=root;Password=rootroot";
            cnn = new MySqlConnection(connetionString);
            cnn.Open();

            sql = "Update actor set actor_name=\"Tom Cruise\" where actor_name = \"Tom\"";

            command = new MySqlCommand(sql, cnn);

            adapter.UpdateCommand = new MySqlCommand(sql, cnn);
            adapter.UpdateCommand.ExecuteNonQuery();

            command.Dispose();
            cnn.Close();


        }

        private void button4_Click(object sender, EventArgs e)
        {
            MySqlCommand command;
            MySqlDataAdapter adapter = new MySqlDataAdapter();
            string actor_name = textBox2.Text;
            String sql = " ";
            MySqlConnection cnn;
            string connetionString = @"Data Source=localhost;Initial Catalog=movie_review_website;User ID=root;Password=rootroot";
            cnn = new MySqlConnection(connetionString);
            cnn.Open();

            sql = $"DELETE FROM movie_review_website.actor WHERE actor_name = \"" + actor_name + "\"";

            command = new MySqlCommand(sql, cnn);

            adapter.DeleteCommand = new MySqlCommand(sql, cnn);
            adapter.DeleteCommand.ExecuteNonQuery();

            command.Dispose();
            cnn.Close();
        }

        private void label3_Click(object sender, EventArgs e)
        {

        }

        

        private void label2_Click(object sender, EventArgs e)
        {

        }

        private void label1_Click(object sender, EventArgs e)
        {

        }

        private void label1_Click_1(object sender, EventArgs e)
        {

        }

        private void textBox2_TextChanged(object sender, EventArgs e)
        {

        }
    }
}
